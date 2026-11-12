import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareUpdaterConfig, publicKeyContents, UPDATE_ENDPOINT } from './prepare-updater-config.mjs';

// Synthetic shape only. No key generation or real signing material.
const payload = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 7)]);
const box = (bytes = payload, comment = 'untrusted comment: synthetic public key') =>
  Buffer.from(`${comment}\n${bytes.toString('base64')}\n`).toString('base64');
const publicKey = box();
const secret = 'DUMMY-SECRET-MUST-NEVER-APPEAR';
const env = { TAURI_SIGNING_PRIVATE_KEY: secret, TAURI_SIGNING_PUBLIC_KEY: publicKey };
const script = new URL('./prepare-updater-config.mjs', import.meta.url);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cotal-updater-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, output: join(dir, 'overlay.json') };
}
function cli(args, overrides = {}) {
  return spawnSync(process.execPath, [script.pathname, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env, ...overrides },
  });
}

test('writes minimal overlay mode 600 and matching compiled-key guidance', async t => {
  const { output } = await fixture(t);
  const guidance = await prepareUpdaterConfig('v1.2.3', '1.2.3', output, env);
  assert.deepEqual(guidance, { COTAL_UPDATER_PUBLIC_KEY: publicKey });
  const text = await readFile(output, 'utf8');
  assert.ok(!text.includes(secret));
  assert.deepEqual(JSON.parse(text), {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: publicKey, requireSignedVersion: true, endpoints: [UPDATE_ENDPOINT] } },
  });
  assert.equal(new URL(UPDATE_ENDPOINT).protocol, 'https:');
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('accepts canonical box with outer file whitespace and CRLF', () => {
  assert.equal(publicKeyContents(`\n${publicKey}\n`), publicKey);
  const crlf = Buffer.from(`untrusted comment: test\r\n${payload.toString('base64')}\r\n`).toString('base64');
  assert.equal(publicKeyContents(crlf), crlf);
});

for (const [name, value] of Object.entries({
  path: '/tmp/key.pub', raw: payload.toString('base64'), invalid: 'not base64!',
  short: box(payload.subarray(0, 41)), long: box(Buffer.alloc(43)),
  algorithm: box(Buffer.alloc(42)), comment: box(payload, 'secret key'),
  utf8: Buffer.from([255, 254]).toString('base64'),
  extraLine: Buffer.from(`untrusted comment: test\n${payload.toString('base64')}\nextra\n`).toString('base64'),
  noncanonical: publicKey.replace(/=+$/, ''),
})) {
  test(`rejects public key ${name} without output`, async t => {
    const { dir, output } = await fixture(t);
    await assert.rejects(prepareUpdaterConfig('v1.2.3', '1.2.3', output, { ...env, TAURI_SIGNING_PUBLIC_KEY: value }), /TAURI_SIGNING_PUBLIC_KEY/);
    assert.deepEqual(await readdir(dir), []);
  });
}

for (const name of Object.keys(env)) {
  for (const value of [undefined, '', ' \n ']) {
    test(`requires ${name}: ${JSON.stringify(value)}`, async t => {
      const { dir, output } = await fixture(t);
      await assert.rejects(prepareUpdaterConfig('v1.2.3', '1.2.3', output, { ...env, [name]: value }), new RegExp(name));
      assert.deepEqual(await readdir(dir), []);
    });
  }
}

for (const [tag, version] of [['1.2.3', '1.2.3'], ['v1.2.4', '1.2.3'], ['refs/tags/v1.2.3', '1.2.3'], ['v01.2.3', '01.2.3'], ['v1.2', '1.2'], ['v1.2.3\n', '1.2.3']]) {
  test(`rejects tag/version ${JSON.stringify([tag, version])}`, async t => {
    const { dir, output } = await fixture(t);
    await assert.rejects(prepareUpdaterConfig(tag, version, output, env), /tag/);
    assert.deepEqual(await readdir(dir), []);
  });
}

test('accepts exact prerelease and metadata version', async t => {
  const { output } = await fixture(t);
  await prepareUpdaterConfig('v1.2.3-rc.1+build.2', '1.2.3-rc.1+build.2', output, env);
});

test('existing file, directory and live or dangling symlink are never replaced', async t => {
  const { dir, output } = await fixture(t);
  await writeFile(output, 'preserved');
  for (const target of [output, dir]) {
    await assert.rejects(prepareUpdaterConfig('v1.2.3', '1.2.3', target, env), { code: 'EEXIST' });
  }
  for (const [name, target] of [['live', output], ['dangling', join(dir, 'absent')]]) {
    const link = join(dir, name);
    await symlink(target, link);
    await assert.rejects(prepareUpdaterConfig('v1.2.3', '1.2.3', link, env), { code: 'EEXIST' });
  }
  assert.equal(await readFile(output, 'utf8'), 'preserved');
});

test('concurrent exclusive writers produce one complete output', async t => {
  const { output } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => prepareUpdaterConfig('v1.2.3', '1.2.3', output, env)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).plugins.updater.pubkey, publicKey);
});

test('missing parent fails without output', async t => {
  const { dir } = await fixture(t);
  await assert.rejects(prepareUpdaterConfig('v1.2.3', '1.2.3', join(dir, 'absent', 'out'), env), { code: 'ENOENT' });
  assert.deepEqual(await readdir(dir), []);
});

test('CLI emits JSON environment guidance and never dummy private contents', async t => {
  const { output } = await fixture(t);
  const result = cli(['v1.2.3', '1.2.3', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { COTAL_UPDATER_PUBLIC_KEY: publicKey });
  assert.equal(result.stderr, '');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});

test('CLI negatives name inputs, reject arity and filesystem errors, never leak secret', async t => {
  const { dir, output } = await fixture(t);
  for (const [args, overrides, expected] of [
    [[], {}, /Usage/],
    [['v1.2.3', '1.2.3', output, 'extra'], {}, /Usage/],
    [['v9.0.0', '1.2.3', output], {}, /tag/],
    [['v1.2.3', '1.2.3', output], { TAURI_SIGNING_PRIVATE_KEY: '' }, /TAURI_SIGNING_PRIVATE_KEY/],
    [['v1.2.3', '1.2.3', output], { TAURI_SIGNING_PUBLIC_KEY: secret }, /TAURI_SIGNING_PUBLIC_KEY/],
    [['v1.2.3', '1.2.3', dir], {}, /EEXIST/],
    [['v1.2.3', '1.2.3', join(dir, 'absent', 'out')], {}, /ENOENT/],
  ]) {
    const result = cli(args, overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(secret));
    assert.deepEqual(await readdir(dir), []);
  }
});
