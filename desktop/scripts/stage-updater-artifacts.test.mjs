import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stageUpdaterArtifacts } from './stage-updater-artifacts.mjs';
import { RELEASE_PLATFORMS, generateManifest } from './generate-updater-manifest.mjs';

const matrix = [
  ['macOS', 'ARM64', [['darwin-aarch64', 'macos', 'Cotal.app.tar.gz']]],
  ['macOS', 'X64', [['darwin-x86_64', 'macos', 'Cotal.app.tar.gz']]],
  ['Linux', 'X64', [['linux-x86_64-appimage', 'appimage', 'Cotal_1.2.3_amd64.AppImage'], ['linux-x86_64-deb', 'deb', 'Cotal_1.2.3_amd64.deb'], ['linux-x86_64-rpm', 'rpm', 'Cotal-1.2.3-1.x86_64.rpm']]],
  ['Windows', 'X64', [['windows-x86_64-nsis', 'nsis', 'Cotal_1.2.3_x64-setup.exe'], ['windows-x86_64-msi', 'msi', 'Cotal_1.2.3_x64_en-US.msi']]],
];
const signature = Buffer.from(`untrusted comment: fixture\n${Buffer.alloc(74).toString('base64')}\ntrusted comment: fixture\n${Buffer.alloc(64).toString('base64')}\n`).toString('base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, row = matrix[0]) {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'cotal-stage-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'bundle');
  await mkdir(root);
  for (const [platform, directory, name] of row[2]) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, name), Buffer.from(`\0signed bytes ${platform}\xff`, 'latin1'));
    await writeFile(join(root, directory, `${name}.sig`), `${signature}\n`);
  }
  return { temp, root, options: { os: row[0], arch: row[1], version: '1.2.3', bundleRoot: root, outputDir: join(temp, 'staged') } };
}

test('all seven entries preserve bytes and form a complete manifest without Mac collisions', async t => {
  const combined = await mkdtemp(join(await realpath(tmpdir()), 'cotal-stage-combined-'));
  t.after(() => rm(combined, { recursive: true, force: true }));
  const artifacts = [];
  const names = new Set();
  for (const row of matrix) {
    const { root, options } = await fixture(t, row);
    const inventory = await stageUpdaterArtifacts(options);
    assert.deepEqual(JSON.parse(await readFile(join(options.outputDir, 'inventory.json'), 'utf8')), inventory);
    assert.equal(inventory.artifacts.length, row[2].length);
    for (const artifact of inventory.artifacts) {
      const [, directory, name] = row[2].find(([platform]) => platform === artifact.platform);
      assert.ok(artifact.file.endsWith(RELEASE_PLATFORMS[artifact.platform]));
      assert.ok(!names.has(artifact.file));
      names.add(artifact.file);
      for (const suffix of ['', '.sig']) {
        const bytes = await readFile(join(options.outputDir, artifact.file + suffix));
        assert.equal(hash(bytes), hash(await readFile(join(root, directory, name + suffix))));
        await writeFile(join(combined, artifact.file + suffix), bytes);
      }
      artifacts.push(artifact);
    }
  }
  const manifest = await generateManifest({ version: '1.2.3', artifacts }, combined);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(RELEASE_PLATFORMS).sort());
});

for (const kind of ['missing artifact', 'missing sidecar', 'ambiguous', 'artifact symlink', 'sidecar symlink', 'directory symlink', 'root symlink', 'empty artifact', 'empty sidecar', 'existing output', 'output symlink']) {
  test(`rejects ${kind}`, async t => {
    const { root, temp, options } = await fixture(t);
    const folder = join(root, 'macos');
    const source = join(folder, 'Cotal.app.tar.gz');
    if (kind.startsWith('missing')) await rm(source + (kind === 'missing sidecar' ? '.sig' : ''));
    if (kind === 'ambiguous') await writeFile(join(folder, 'Other.app.tar.gz'), 'other');
    if (kind === 'artifact symlink' || kind === 'sidecar symlink') {
      const path = source + (kind === 'sidecar symlink' ? '.sig' : '');
      await rm(path);
      await writeFile(join(temp, 'target'), 'bytes');
      await symlink(join(temp, 'target'), path);
    }
    if (kind === 'directory symlink' || kind === 'root symlink') {
      const path = kind === 'root symlink' ? root : folder;
      await rm(path, { recursive: true });
      await mkdir(join(temp, 'elsewhere'));
      await symlink(join(temp, 'elsewhere'), path, 'dir');
    }
    if (kind.startsWith('empty')) await writeFile(source + (kind === 'empty sidecar' ? '.sig' : ''), '');
    if (kind === 'existing output') await mkdir(options.outputDir);
    if (kind === 'output symlink') await symlink(root, options.outputDir, 'dir');
    await assert.rejects(stageUpdaterArtifacts(options));
    if (!kind.includes('output')) assert.ok(!(await readdir(temp)).includes('staged'));
  });
}

test('CLI stages a trusted job and refuses invalid inputs', async t => {
  const { options } = await fixture(t);
  const script = fileURLToPath(new URL('./stage-updater-artifacts.mjs', import.meta.url));
  execFileSync(process.execPath, [script, options.os, options.arch, options.version, options.bundleRoot, options.outputDir]);
  assert.equal(JSON.parse(await readFile(join(options.outputDir, 'inventory.json'), 'utf8')).artifacts[0].platform, 'darwin-aarch64');
  for (const override of [{ os: 'Linux', arch: 'ARM64' }, { version: '../bad' }, { version: '01.2.3' }, { outputDir: join(options.bundleRoot, 'nested') }]) {
    await assert.rejects(stageUpdaterArtifacts({ ...options, ...override }));
  }
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }), /Command failed/);
});
