import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { ageSchedulerClocks, hostedGuard, readRecords } from './reproduce-6385-current.mjs';
import { archiveInventory, buildFaultCandidate, hash6385, injectDaemonFault, source6385 } from './6385-fault-candidate.mjs';

test('hosted guard refuses laptop, root, foreign runtime and inherited product settings', () => {
  const home = mkdtempSync(join(tmpdir(), '6385-guard-'));
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: home, XDG_RUNTIME_DIR: '/run/user/1001' };
  hostedGuard({ env, platform: 'linux', uid: 1001, home, os: 'ID=ubuntu' });
  for (const changed of [{ RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_ACTIONS: 'false' }, { XDG_RUNTIME_DIR: '/run/user/0' }, { COTAL_HOME: '/foreign' }]) {
    assert.throws(() => hostedGuard({ env: { ...env, ...changed }, platform: 'linux', uid: 1001, home, os: 'ID=ubuntu' }));
  }
  assert.throws(() => hostedGuard({ env, platform: 'linux', uid: 0, home }));
});

test('clock aging preserves learned release and attempt outcome without inventing markers', () => {
  const check = { latest: '0.164.1018', firstSeenAt: 123, checkedAt: 456, attemptedAt: 789 };
  const attempt = { version: '0.164.18', result: 'not checked', failures: 0, next: 999 };
  const result = ageSchedulerClocks(check, attempt, check.latest, 100000000);
  assert.equal(result.check.firstSeenAt, 10000000);
  assert.equal(result.attempt.next, 10000000);
  assert.equal(result.attempt.result, attempt.result);
  assert.equal(result.check.latest, check.latest);
  assert.equal(check.firstSeenAt, 123);
  assert.throws(() => ageSchedulerClocks(check, attempt, 'other'));
  assert.throws(() => ageSchedulerClocks({ latest: check.latest }, attempt, check.latest));
});

test('fault injection is unique and only before daemon serve', () => {
  const source = 'const version = 1;\ntry { running = await serveDaemon({}); } catch(e) { throw e; }';
  assert.match(injectDaemonFault(source, 'exit'), /process\.exit\(86\);\n    running = await serveDaemon/);
  assert.match(injectDaemonFault(source, 'hang'), /setInterval/);
  assert.throws(() => injectDaemonFault(source + source, 'exit'));
  assert.throws(() => injectDaemonFault('no boundary', 'hang'));
  assert.throws(() => injectDaemonFault(source, 'kill'));
});

test('fault builder changes copied archive and truthfully inventories bytes, preserving input', async () => {
  const root = mkdtempSync(join(tmpdir(), '6385-pack-'));
  const input = join(root, 'input'), packageRoot = join(root, 'staging');
  mkdirSync(input); mkdirSync(join(packageRoot, 'package/dist/daemon'), { recursive: true });
  writeFileSync(join(packageRoot, 'package/package.json'), JSON.stringify({ name: 'cotal-ai', version: '0.164.1018' }));
  writeFileSync(join(packageRoot, 'package/dist/daemon/command.js'), 'async function serve() { let running; running = await serveDaemon({}); }');
  const archive = join(input, 'binary.tgz');
  await create({ file: archive, cwd: packageRoot, gzip: true }, ['package']);
  const bytes = readFileSync(archive);
  const manifest = { source: source6385, prepublishOnly: ['cotal-ai'], packages: [{ name: 'cotal-ai', version: '0.164.1018', archive: 'binary.tgz', sha256: hash6385(bytes), files: await archiveInventory(archive) }] };
  writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
  for (const fault of ['exit', 'hang']) {
    const output = join(root, fault);
    const receipt = await buildFaultCandidate(input, output, fault);
    const changed = JSON.parse(readFileSync(join(output, 'manifest.json')));
    assert.equal(changed.testFault.fault, fault);
    assert.equal(receipt.archiveSha256, hash6385(readFileSync(join(output, 'binary.tgz'))));
    assert.deepEqual(changed.packages[0].files, await archiveInventory(join(output, 'binary.tgz')));
    assert.notEqual(receipt.beforeSha256, receipt.afterSha256);
    assert.deepEqual(Object.keys(changed.packages[0].files).sort(), Object.keys(manifest.packages[0].files).sort());
    for (const [name, hash] of Object.entries(manifest.packages[0].files)) {
      if (name !== 'dist/daemon/command.js') assert.equal(changed.packages[0].files[name], hash);
    }
    assert.deepEqual(readFileSync(archive), bytes);
    assert.deepEqual(JSON.parse(readFileSync(join(input, 'manifest.json'))), manifest);
    await assert.rejects(buildFaultCandidate(input, output, fault));
  }
});

test('filesystem evidence records absent journal and snapshot before command execution', () => {
  const root = mkdtempSync(join(tmpdir(), '6385-records-'));
  const config = join(root, 'config'); mkdirSync(config);
  mkdirSync(join(config, '.update-snapshot-real'));
  const records = readRecords(root, config);
  assert.deepEqual(records['update-recovery.json'], { exists: false });
  assert.equal(records.snapshots[0].name, '.update-snapshot-real');
  writeFileSync(join(root, 'update-recovery.json'), '{"phase":"paused"}');
  assert.equal(records['update-recovery.json'].exists, false);
  assert.equal(readRecords(root, config)['update-recovery.json'].exists, true);
});
