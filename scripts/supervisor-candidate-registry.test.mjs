import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { create } from 'tar';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';

test('dual candidate registry keeps verified source archives and target ordering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dual-candidate-'));
  const names = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url))).fixed.flat();
  for (const [label, version] of [['A', '0.999.1'], ['B', '0.999.2']]) {
    const directory = join(root, label); mkdirSync(directory);
    const packages = [];
    for (const [index, name] of names.entries()) {
      const source = join(directory, String(index)); mkdirSync(join(source, 'package'), { recursive: true });
      writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name, version }));
      const archive = `${index}-${version}.tgz`, file = join(directory, archive);
      await create({ cwd: source, file, gzip: true }, ['package']);
      packages.push({ name, version, archive, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
    }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ source: 'a'.repeat(40), packages }));
  }
  const overlay = await candidateRegistry(join(root, 'B'), 'B', 'https://registry.npmjs.org/', join(root, 'A'));
  try {
    for (const version of ['0.999.1', '0.999.2']) {
      const response = await fetch(`${overlay.url}/cotal-ai/${version}`); assert.equal(response.status, 200);
      const metadata = await response.json(); assert.equal(metadata.version, version);
      const archive = await fetch(metadata.dist.tarball); assert.equal(archive.status, 200);
      assert.equal(`sha512-${createHash('sha512').update(Buffer.from(await archive.arrayBuffer())).digest('base64')}`, metadata.dist.integrity);
    }
    const metadata = await (await fetch(`${overlay.url}/cotal-ai`)).json(); assert.equal(metadata['dist-tags'].latest, '0.999.2');
    assert.equal((await fetch(overlay.url + '/cotal-ai', { method: 'PUT' })).status, 405);
  } finally { await overlay.close(); }
  const manifest = JSON.parse(readFileSync(join(root, 'A/manifest.json'))); manifest.source = 'b'.repeat(40);
  writeFileSync(join(root, 'A/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(candidateRegistry(join(root, 'B'), 'B', 'https://registry.npmjs.org/', join(root, 'A')), /must match target source/);
});
