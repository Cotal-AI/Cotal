import assertions from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { countedAssert, emitSentinel, skipSuite } from './sentinel.mjs';

if (!['linux', 'darwin'].includes(process.platform)) skipSuite('POSIX global update child recovery');
const counted = countedAssert(assertions), assert = counted.assert;

// Keep the installed entry, npm cache and logs for the interrupted command's evidence.
const repo = resolve(import.meta.dirname, '../..');
const { beginGlobalUpdateChild, claimGlobalNpmUpdateLock, processStartToken, processGroupMembers } = await import(pathToFileURL(join(repo, 'packages/workspace/dist/index.js')).href);
const root = mkdtempSync(join(tmpdir(), 'update-child-recovery-'));
const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const target = '99.0.0';
const archives = new Map();
for (const version of [previous, target]) {
  const payload = join(root, version, 'package');
  mkdirSync(join(payload, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' } }));
  writeFileSync(join(payload, 'dist/cotal.js'), `#!/usr/bin/env node
const fs = require('node:fs');
const once = process.env.COTAL_HOME + '/interrupted-once';
if (process.env.RECOVERY_INTERRUPT === '1' && !fs.existsSync(once)) {
  fs.writeFileSync(once, 'reconcile reached');
  process.kill(process.pid, 'SIGKILL');
}
console.log('fixture reconciled');
`, { mode: 0o755 });
  const archive = join(root, version + '.tgz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, version), 'package']).status, 0);
  archives.set(version, readFileSync(archive));
}
let origin;
const server = createServer((request, response) => {
  if (request.url?.endsWith('.tgz')) return response.end(archives.get(request.url.slice(1, -4)));
  const versions = Object.fromEntries([...archives].map(([version, bytes]) => [version, {
    name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' },
    dist: { tarball: `${origin}/${version}.tgz`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
  }]));
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: target }, versions }));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
origin = `http://127.0.0.1:${server.address().port}`;
console.log(`Retained update-child evidence: ${root}`);
try {
  const scenarios = process.argv.includes('--matching-group-only') ? ['matching-group']
    : process.argv.includes('--group-identity') ? ['reused-leader', 'previous-boot', 'unidentified-group', ...(process.platform === 'linux' ? ['zombie-group'] : [])]
    : ['control', 'interrupted', 'matching-group', 'reused-leader', 'previous-boot', 'unidentified-group', ...(process.platform === 'linux' ? ['zombie-group'] : [])];
  for (const scenario of scenarios) {
    const cell = join(root, scenario);
    for (const name of ['home', 'cotal', 'config', 'runtime', 'prefix', '.cotal']) mkdirSync(join(cell, name), { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_') && !key.toLowerCase().startsWith('npm_config_')));
    Object.assign(env, {
      HOME: join(cell, 'home'), COTAL_HOME: join(cell, 'cotal'), XDG_CONFIG_HOME: join(cell, 'config'), XDG_RUNTIME_DIR: join(cell, 'runtime'),
      npm_config_prefix: join(cell, 'prefix'), npm_config_cache: join(cell, 'cache'), npm_config_registry: origin,
      npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
      COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_NO_UPDATE_CHECK: '1', COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1', NO_COLOR: '1',
      RECOVERY_INTERRUPT: scenario === 'interrupted' ? '1' : '0',
    });
    let holder;
    let group;
    let mutation;
    const markerPath = join(cell, 'prefix/lib/node_modules/.cotal-update-child');
    try {
    if (!['control', 'interrupted'].includes(scenario)) {
      mkdirSync(join(cell, 'prefix/lib/node_modules'), { recursive: true, mode: 0o700 });
      const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!predicate()) { assertions(Date.now() < deadline, 'group fixture did not become ready'); await new Promise(done => setTimeout(done, 20)); }
      };
      if (scenario === 'zombie-group') {
        holder = spawn('python3', ['-I', '-c', `
import os, time
pid = os.fork()
if pid == 0:
    os.setsid()
    os._exit(0)
with open('group', 'w') as f:
    f.write(str(pid))
while not os.path.exists('release'):
    time.sleep(0.02)
os.waitpid(pid, 0)
`], { cwd: cell, env, stdio: 'ignore' });
        await until(() => existsSync(join(cell, 'group')));
        group = Number(readFileSync(join(cell, 'group'), 'utf8'));
        await until(() => readFileSync(`/proc/${group}/stat`, 'utf8').split(') ').at(-1).startsWith('Z '));
        assert.equal(processGroupMembers(group).length, 0, 'the held zombie has no live group members');
        process.kill(-group, 0); // Positive control: kill(0) alone still reports this group.
      } else {
        holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: cell, env, detached: true, stdio: 'ignore' });
        group = holder.pid;
        await until(() => processStartToken(group) !== undefined);
      }
      const boot = process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        : (await import(pathToFileURL(join(repo, 'packages/workspace/dist/darwin-process.js')).href)).darwinProcessBinding().hostIdentity().boot;
      if (scenario === 'matching-group') {
        const release = claimGlobalNpmUpdateLock(join(cell, 'prefix/lib/node_modules'));
        try {
          mutation = beginGlobalUpdateChild(join(cell, 'prefix/lib/node_modules'), 'reconcile', true);
          mutation.markLive(group);
        } finally { release(); }
        const record = JSON.parse(readFileSync(markerPath, 'utf8'));
        assert.equal(record.group, group);
        assert.equal(record.groupStart, processStartToken(group));
        assert.equal(record.boot, boot);
      } else {
        const marker = { phase: 'ambiguous', owner: process.pid, nonce: '0'.repeat(24), operation: 'global reconcile', reason: 'interrupted child', group,
          ...(scenario === 'unidentified-group' ? {} : { groupStart: scenario === 'reused-leader' ? '0' : processStartToken(group), boot: scenario === 'previous-boot' ? '00000000-0000-0000-0000-000000000000' : boot }) };
        writeFileSync(markerPath, JSON.stringify(marker));
      }
    }
    const command = async () => {
      const child = spawn(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self'], { cwd: cell, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => output += bytes);
      child.stderr.on('data', bytes => output += bytes);
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      return { code, output };
    };
    let { code, output } = await command();
    writeFileSync(join(cell, 'update.log'), output);
    console.log(`${scenario} exit ${code}\n${output}`);
    if (scenario === 'unidentified-group') {
      const before = readFileSync(markerPath, 'utf8');
      assert.equal(code, 1, output);
      assert.match(output, /cannot verify global update child custody/);
      assert.match(output, /inspect the recorded process group.*remove the marker and retry/);
      const retry = await command();
      writeFileSync(join(cell, 'retry.log'), retry.output);
      assert.equal(retry.code, 1, retry.output);
      assert.match(retry.output, /inspect the recorded process group.*remove the marker and retry/);
      assert.equal(readFileSync(markerPath, 'utf8'), before);
      continue;
    }
    if (scenario === 'matching-group') {
      const before = readFileSync(markerPath, 'utf8');
      assert.equal(code, 1, output);
      assert.match(output, /global reconcile process group is still running/);
      assert.equal(holder.exitCode, null, 'a matching leader is retained, not stopped');
      holder.kill('SIGTERM');
      await new Promise(done => holder.once('close', done));
      mutation.complete(null, 'SIGTERM', 'reconcile child terminated by SIGTERM');
      const record = JSON.parse(readFileSync(markerPath, 'utf8'));
      const live = JSON.parse(before);
      assert.equal(record.groupStart, live.groupStart);
      assert.equal(record.boot, live.boot);
      ({ code, output } = await command());
      writeFileSync(join(cell, 'retry.log'), output);
      console.log(`matching-group after exit ${code}\n${output}`);
    }
    assert.equal(code, 0, `${scenario}: plain self-update must recover its interrupted reconcile`);
    assert.match(output, scenario === 'interrupted' ? /repaired and reconciled/ : /installed globally and reconciled/);
    assert.equal(existsSync(markerPath), false);
    assert.equal(JSON.parse(readFileSync(join(cell, 'cotal/update-recovery.json'), 'utf8')), null);
    if (scenario === 'interrupted') {
      assert.equal(existsSync(join(cell, 'cotal/interrupted-once')), true);
      assert.match(output, /Retrying reconciliation/);
    }
    if (holder && scenario !== 'matching-group') assert.equal(holder.exitCode, null, 'the updater never signals an unrelated process or reaps its zombie');
    } finally {
      if (holder) {
        if (scenario === 'zombie-group') writeFileSync(join(cell, 'release'), 'release');
        else if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
        if (holder.exitCode === null && holder.signalCode === null) await new Promise(done => holder.once('close', done));
      }
    }
  }
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await new Promise(done => server.close(done)); }
