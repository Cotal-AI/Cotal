import assert from 'node:assert/strict';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';

test('candidate overlay serves packed closure, stock metadata and read-only policy', async () => {
  const parent = '/var/tmp/upgrade-matrix';
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'registry-test-'));
  const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat();
  const packages = [];
  for (const [i, name] of names.entries()) {
    const dir = join(root, String(i));
    mkdirSync(join(dir, 'package'), { recursive: true });
    writeFileSync(join(dir, 'package/package.json'), JSON.stringify({ name, version: '0.999.0', type: 'module' }));
    const archive = `${i}.tgz`;
    await create({ cwd: dir, file: join(root, archive), gzip: true }, ['package']);
    packages.push({ name, version: '0.999.0', archive, sha256: createHash('sha256').update(readFileSync(join(root, archive))).digest('hex') });
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ source: 'a'.repeat(40), packages }));
  const overlay = await candidateRegistry(root, 'B', 'https://registry.npmjs.org/');
  try {
    const metadata = await (await fetch(`${overlay.url}/cotal-ai`)).json();
    assert.equal(metadata['dist-tags'].latest, '0.999.0');
    assert.equal(metadata.versions['0.999.0'].version, '0.999.0');
    const target = await (await fetch(`${overlay.url}/cotal-ai/0.999.0`)).json();
    const archive = Buffer.from(await (await fetch(target.dist.tarball)).arrayBuffer());
    assert.equal(createHash('sha256').update(archive).digest('hex'), packages.find(pkg => pkg.name === 'cotal-ai').sha256);
    assert.equal((await fetch(`${overlay.url}/cotal-ai`, { method: 'PUT', body: '{}' })).status, 405);
  } finally { await overlay.close(); }
  const sourceOverlay = await candidateRegistry(root, 'A', 'https://registry.npmjs.org/');
  try {
    const metadata = await (await fetch(`${sourceOverlay.url}/cotal-ai`)).json();
    assert.notEqual(metadata['dist-tags'].latest, '0.999.0');
    assert.equal(metadata.versions['0.999.0'].version, '0.999.0');
    const installedMetadata = await (await fetch(`${sourceOverlay.url}/cotal-ai/0.999.0`)).json();
    assert(installedMetadata.dist.integrity.startsWith('sha512-'));
  } finally { await sourceOverlay.close(); }
});

import { test } from 'node:test';
import { exclusion, requiresManualStep, sources, states, methods } from './automatic-update-platform-baseline.mjs';

test('funding suggestions do not require upgrade intervention', () => {
  assert.equal(requiresManualStep('61 packages are looking for funding\n  run `npm fund` for details\n✓ cotal-ai@0.164.0 installed globally and reconciled'), false);
});
test('actual upgrade remedies and unknown outcomes stay red', () => {
  for (const text of ['run `cotal update --self`', 'Outcome unconfirmed', 'Code: OPERATION_UNKNOWN', 'an interrupted update needs restoration', 'manual intervention']) assert.equal(requiresManualStep(text), true, text);
});
test('matrix includes each requested source, state and method', () => {
  assert.deepEqual(sources, ['0.155.0', '0.160.7', '0.162.0', '0.163.5', '0.164.0', 'latest']);
  assert.equal(states.length, 7);
  assert.equal(methods.length, 3);
  assert(exclusion({ layout: 'npm', method: 'installer', state: 'fresh' }));
  assert(exclusion({ layout: 'npm', method: 'scheduler', state: 'fresh' }));
  assert.equal(exclusion({ layout: 'npm', method: 'scheduler', state: 'daemon' }), undefined);
});
