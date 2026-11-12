import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { RELEASE_PLATFORMS } from './generate-updater-manifest.mjs';
import { verifyUpdaterAssets } from './verify-updater-assets.mjs';

const signature = Buffer.from(`untrusted comment: fake fixture\n${Buffer.alloc(74, 1).toString('base64')}\ntrusted comment: fixture\n${Buffer.alloc(64, 2).toString('base64')}\n`).toString('base64');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verify-updater-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const remote = join(root, 'remote');
  await mkdir(source);
  await mkdir(remote);
  const artifacts = [];
  for (const [platform, suffix] of Object.entries(RELEASE_PLATFORMS)) {
    await mkdir(join(source, platform));
    const file = `${platform}/Cotal-${platform}${suffix}`;
    artifacts.push({ platform, file });
    await writeFile(join(source, file), `artifact ${platform}`);
    await writeFile(join(source, `${file}.sig`), `${signature}\n`);
    for (const path of [file, `${file}.sig`]) await copyFile(join(source, path), join(remote, basename(path)));
  }
  const inventory = { version: '1.2.3', artifacts };
  const input = join(source, 'inventory.json');
  await writeFile(input, JSON.stringify(inventory));
  return { source, remote, inventory, input, name: basename(artifacts[0].file) };
}

test('verifies seven artifacts and signatures, tolerates unrelated installers, CLI prints hashes only', async t => {
  const f = await fixture(t);
  await writeFile(join(f.remote, 'Other-installer.exe'), 'unrelated');
  const result = await verifyUpdaterAssets(f.input, f.remote);
  assert.equal(result.artifacts, 7);
  assert.equal(result.signatures, 7);
  assert.equal(result.files.length, 14);
  for (const file of result.files) {
    assert.ok(file.bytes > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  const output = execFileSync(process.execPath, ['desktop/scripts/verify-updater-assets.mjs', f.input, f.remote], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), result);
  assert.ok(!output.includes(signature));
});

for (const suffix of ['', '.sig']) {
  test(`rejects same-length corrupted downloaded ${suffix || 'artifact'}`, async t => {
    const f = await fixture(t);
    const path = join(f.remote, `${f.name}${suffix}`);
    const bytes = await readFile(path);
    bytes[0] ^= 1;
    await writeFile(path, bytes);
    await assert.rejects(verifyUpdaterAssets(f.input, f.remote), /differs/);
  });
  for (const fault of ['missing', 'empty', 'symlink']) {
    test(`rejects ${fault} downloaded ${suffix || 'artifact'}`, async t => {
      const f = await fixture(t);
      const path = join(f.remote, `${f.name}${suffix}`);
      await rm(path);
      if (fault === 'empty') await writeFile(path, '');
      if (fault === 'symlink') await symlink(join(f.source, `${f.inventory.artifacts[0].file}${suffix}`), path);
      await assert.rejects(verifyUpdaterAssets(f.input, f.remote));
    });
  }
}

test('rejects downloaded case aliases and unrelated duplicate aliases', async t => {
  const f = await fixture(t);
  await copyFile(join(f.remote, f.name), join(f.remote, f.name.toUpperCase()));
  await assert.rejects(verifyUpdaterAssets(f.input, f.remote), /alias collision/);
  await rm(join(f.remote, f.name.toUpperCase()));
  await writeFile(join(f.remote, 'other.exe'), 'a');
  await writeFile(join(f.remote, 'OTHER.exe'), 'b');
  await assert.rejects(verifyUpdaterAssets(f.input, f.remote), /alias collision/);
});

for (const fault of ['escape', 'duplicate', 'missing-platform', 'source-symlink', 'bad-signature']) {
  test(`validates source inventory: ${fault}`, async t => {
    const f = await fixture(t);
    if (fault === 'escape') f.inventory.artifacts[0].file = '../outside.app.tar.gz';
    if (fault === 'duplicate') f.inventory.artifacts[1].file = f.inventory.artifacts[0].file;
    if (fault === 'missing-platform') f.inventory.artifacts.pop();
    if (fault === 'source-symlink') {
      const path = join(f.source, f.inventory.artifacts[0].file);
      await rm(path);
      await symlink(join(f.remote, f.name), path);
    }
    if (fault === 'bad-signature') await writeFile(join(f.source, `${f.inventory.artifacts[0].file}.sig`), 'not a signature');
    await writeFile(f.input, JSON.stringify(f.inventory));
    await assert.rejects(verifyUpdaterAssets(f.input, f.remote));
  });
}

test('requires separate source and download directories', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyUpdaterAssets(f.input, f.source), /separate roots/);
});
