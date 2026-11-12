import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RELEASE_PLATFORMS, generateManifest } from './generate-updater-manifest.mjs';
import { mergeUpdaterInventories } from './merge-updater-inventories.mjs';

const version = '1.2.3';
// Shape-only fixture, not a signed release or a verification claim.
const signature = Buffer.from(`untrusted comment: fixture\n${Buffer.alloc(74).toString('base64')}\ntrusted comment: fixture\n${Buffer.alloc(64).toString('base64')}\n`).toString('base64');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'merge-updater-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fragments = [];
  const inventories = [];
  for (const [index, [platform, suffix]] of Object.entries(Object.entries(RELEASE_PLATFORMS))) {
    const directory = `job-${index}`;
    await mkdir(join(root, directory));
    const file = `Cotal-${platform}${suffix}`;
    await writeFile(join(root, directory, file), 'artifact fixture');
    await writeFile(join(root, directory, `${file}.sig`), signature);
    const inventory = { version, artifacts: [{ platform, file }] };
    inventories.push(inventory);
    fragments.push(`${directory}/inventory.json`);
    await writeFile(join(root, fragments.at(-1)), JSON.stringify(inventory));
  }
  return {
    root, fragments, inventories,
    args: { artifactRoot: root, fragments, version, tag: `v${version}` },
    save: async (index = 0) => writeFile(join(root, fragments[index]), JSON.stringify(inventories[index])),
  };
}

test('merges deterministically, rebases files and feeds generator', async t => {
  const f = await fixture(t);
  const merged = await mergeUpdaterInventories(f.args);
  assert.equal(merged.artifacts.length, 7);
  assert.equal(merged.artifacts[0].file, `job-0/${f.inventories[0].artifacts[0].file}`);
  assert.deepEqual(merged, await mergeUpdaterInventories({ ...f.args, fragments: [...f.fragments].reverse() }));
  assert.equal(Object.keys((await generateManifest(merged, f.root)).platforms).length, 7);
});

const cases = {
  'tag mismatch': async f => { f.args.tag = 'v9.9.9'; },
  'invalid version': async f => { f.args.version = 'no'; f.args.tag = 'vno'; },
  'missing root': async f => { f.args.artifactRoot = ''; },
  'no fragments': async f => { f.args.fragments = []; },
  'absolute fragment': async f => { f.args.fragments = [join(f.root, f.fragments[0])]; },
  'escaping fragment': async f => { f.args.fragments = ['../inventory.json']; },
  'missing fragment': async f => { f.args.fragments = ['absent.json']; },
  'duplicate fragment': async f => { f.args.fragments = [...f.fragments, f.fragments[0]]; },
  'fragment extra field': async f => { f.inventories[0].notes = 'no'; await f.save(); },
  'fragment missing field': async f => { delete f.inventories[0].version; await f.save(); },
  'fragment array': async f => { await writeFile(join(f.root, f.fragments[0]), '[]'); },
  'invalid JSON': async f => { await writeFile(join(f.root, f.fragments[0]), '{'); },
  'version mismatch': async f => { f.inventories[0].version = '2.0.0'; await f.save(); },
  'empty artifacts': async f => { f.inventories[0].artifacts = []; await f.save(); },
  'nonarray artifacts': async f => { f.inventories[0].artifacts = {}; await f.save(); },
  'artifact extra field': async f => { f.inventories[0].artifacts[0].url = 'no'; await f.save(); },
  'artifact missing field': async f => { delete f.inventories[0].artifacts[0].file; await f.save(); },
  'absolute asset': async f => { f.inventories[0].artifacts[0].file = '/asset'; await f.save(); },
  'escaping asset': async f => { f.inventories[0].artifacts[0].file = '../../asset'; await f.save(); },
  'missing asset': async f => { await unlink(join(f.root, 'job-0', f.inventories[0].artifacts[0].file)); },
  'empty asset': async f => { await writeFile(join(f.root, 'job-0', f.inventories[0].artifacts[0].file), ''); },
  'missing sidecar': async f => { await unlink(join(f.root, 'job-0', `${f.inventories[0].artifacts[0].file}.sig`)); },
  'invalid sidecar': async f => { await writeFile(join(f.root, 'job-0', `${f.inventories[0].artifacts[0].file}.sig`), 'invalid'); },
  'unknown platform': async f => { f.inventories[0].artifacts[0].platform = 'other'; await f.save(); },
  'duplicate platform': async f => { f.inventories[1].artifacts[0].platform = f.inventories[0].artifacts[0].platform; await f.save(1); },
  'missing platform': async f => { f.args.fragments = f.fragments.slice(1); },
  'duplicate basename': async f => {
    const file = f.inventories[0].artifacts[0].file;
    f.inventories[1].artifacts[0].file = file;
    await writeFile(join(f.root, 'job-1', file), 'fixture');
    await writeFile(join(f.root, 'job-1', `${file}.sig`), signature);
    await f.save(1);
  },
  'symlink fragment': async f => {
    await symlink('inventory.json', join(f.root, 'job-0', 'alias.json'));
    f.args.fragments = ['job-0/alias.json', ...f.fragments.slice(1)];
  },
  'symlink directory': async f => {
    await symlink('job-0', join(f.root, 'alias'));
    f.args.fragments = ['alias/inventory.json', ...f.fragments.slice(1)];
  },
  'symlink root': async f => {
    await symlink(f.root, join(f.root, 'alias-root'));
    f.args.artifactRoot = join(f.root, 'alias-root');
  },
  'symlink asset': async f => {
    const path = join(f.root, 'job-0', f.inventories[0].artifacts[0].file);
    await unlink(path);
    await symlink('inventory.json', path);
  },
  'symlink sidecar': async f => {
    const path = join(f.root, 'job-0', `${f.inventories[0].artifacts[0].file}.sig`);
    await unlink(path);
    await symlink('inventory.json', path);
  },
};
for (const [name, mutate] of Object.entries(cases)) {
  test(`rejects ${name}`, async t => {
    const f = await fixture(t);
    await mutate(f);
    await assert.rejects(mergeUpdaterInventories(f.args));
  });
}

test('CLI writes private new JSON, refuses overwrite and leaves no output on validation failure', async t => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('./merge-updater-inventories.mjs', import.meta.url));
  const output = join(f.root, 'merged.json');
  const args = [script, f.root, version, `v${version}`, output, ...f.fragments];
  const run = arguments_ => spawnSync(process.execPath, arguments_, { encoding: 'utf8' });
  assert.equal(run(args).status, 0);
  const contents = await readFile(output, 'utf8');
  assert.deepEqual(JSON.parse(contents), await mergeUpdaterInventories(f.args));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.notEqual(run(args).status, 0);
  assert.equal(await readFile(output, 'utf8'), contents);
  await unlink(output);
  const outside = [...args];
  outside[4] = join(f.root, '..', 'outside-merged.json');
  assert.notEqual(run(outside).status, 0);
  await symlink(join(f.root, f.fragments[0]), output);
  assert.notEqual(run(args).status, 0);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).version, version);
  await unlink(output);
  f.inventories[0].version = '0.0.0';
  await f.save();
  assert.notEqual(run(args).status, 0);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.notEqual(run([script]).status, 0);
});
