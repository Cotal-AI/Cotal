import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateManifest, RELEASE_PLATFORMS } from './generate-updater-manifest.mjs';

// Deliberately fake signature structure, not signing material or a valid signature.
const signature = Buffer.from(`untrusted comment: fixture\n${Buffer.alloc(74).toString('base64')}\ntrusted comment: fixture\n${Buffer.alloc(64).toString('base64')}\n`).toString('base64');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cotal-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = { version: '1.2.3', notes: 'Release notes', artifacts: [] };
  for (const [platform, extension] of Object.entries(RELEASE_PLATFORMS)) {
    const file = `Cotal_1.2.3_${platform}${extension}`;
    await writeFile(join(root, file), 'built artifact fixture');
    await writeFile(join(root, `${file}.sig`), `${signature}\n`);
    inventory.artifacts.push({ platform, file });
  }
  return { root, inventory };
}

test('complete manifest has exact release URLs and signature contents, never unsigned extras', async t => {
  const { root, inventory } = await fixture(t);
  await writeFile(join(root, 'unsigned.exe'), 'unrelated asset');
  const manifest = await generateManifest(inventory, root);
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(Object.keys(manifest.platforms), Object.keys(RELEASE_PLATFORMS));
  for (const { platform, file } of inventory.artifacts) {
    assert.deepEqual(manifest.platforms[platform], {
      url: `https://github.com/Cotal-AI/Cotal/releases/download/v1.2.3/${file}`,
      signature,
    });
  }
});
for (const version of [undefined, '', 'v1.2.3', '1.2', '01.2.3', '1.2.3-01', '../1.2.3']) {
  test(`reject invalid version ${version}`, async t => {
    const { root, inventory } = await fixture(t);
    inventory.version = version;
    await assert.rejects(generateManifest(inventory, root), /version/);
  });
}
for (const platform of Object.keys(RELEASE_PLATFORMS)) {
  test(`reject missing platform ${platform}`, async t => {
    const { root, inventory } = await fixture(t);
    inventory.artifacts = inventory.artifacts.filter(a => a.platform !== platform);
    await assert.rejects(generateManifest(inventory, root), /Missing platform/);
  });
  test(`reject missing signature ${platform}`, async t => {
    const { root, inventory } = await fixture(t);
    const artifact = inventory.artifacts.find(a => a.platform === platform);
    await rm(join(root, `${artifact.file}.sig`));
    await assert.rejects(generateManifest(inventory, root), /ENOENT/);
  });
}
test('reject bad signature, missing/empty asset, unknown/duplicate platform, URL overrides and traversal', async t => {
  const { root, inventory } = await fixture(t);
  const first = inventory.artifacts[0];
  await writeFile(join(root, `${first.file}.sig`), 'https://example.com/key.sig');
  await assert.rejects(generateManifest(inventory, root), /signature/);
  await writeFile(join(root, `${first.file}.sig`), signature);
  await writeFile(join(root, first.file), '');
  await assert.rejects(generateManifest(inventory, root), /nonempty/);
  await rm(join(root, first.file));
  await assert.rejects(generateManifest(inventory, root), /ENOENT/);
  await writeFile(join(root, first.file), 'artifact');
  for (const change of [
    { ...first, platform: 'linux-unknown' },
    { ...first, url: 'https://evil.example/a' },
    { ...first, file: '../escape.app.tar.gz' },
    { ...first, file: '/tmp/escape.app.tar.gz' },
    { ...first, file: 'evil.dmg' },
  ]) {
    const altered = structuredClone(inventory);
    altered.artifacts[0] = change;
    await assert.rejects(generateManifest(altered, root));
  }
  await assert.rejects(generateManifest({ ...inventory, artifacts: [...inventory.artifacts, first] }, root), /Duplicate platform/);
  await rm(join(root, first.file));
  await symlink(join(root, inventory.artifacts[1].file), join(root, first.file));
  await assert.rejects(generateManifest(inventory, root), /regular file/);
});
test('real CLI writes valid JSON and failure leaves no partial output or clobbered output', async t => {
  const { root, inventory } = await fixture(t);
  const input = join(root, 'inventory.json');
  const output = join(root, 'latest.json');
  const script = fileURLToPath(new URL('./generate-updater-manifest.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' });
  await writeFile(input, JSON.stringify(inventory));
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), await generateManifest(inventory, root));
  assert.notEqual(run().status, 0);
  await rm(output);
  delete inventory.version;
  await writeFile(input, JSON.stringify(inventory));
  const failure = run();
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /version/);
  await assert.rejects(readFile(output), /ENOENT/);
});
