import strictAssert from 'node:assert/strict';
import { countedAssert, emitSentinel } from './sentinel.mjs';
const { assert, cells } = countedAssert(strictAssert);
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const previous = JSON.parse(readFileSync(join(repo, 'bin/package.json'), 'utf8')).version;
const originalEnv = { ...process.env }, originalCwd = process.cwd();
for (const scenario of ['retry', 'rollback', 'paused', 'preflight', 'notarget-manual', 'notarget-auto']) {
 const root = mkdtempSync(join(tmpdir(), 'autoupd-repair-'));
 const home = join(root, 'home'), prefix = join(root, 'prefix');
 for (const dir of [home, prefix, join(root, 'config/cotal'), join(root, '.cotal'), join(root, 'payload/package/dist')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
 const notarget = scenario.startsWith('notarget');
 const archives = {};
 for (const version of ['99.0.0', previous]) {
  writeFileSync(join(root, 'payload/package/package.json'), JSON.stringify({ name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' } }));
  const code = version === previous ? (scenario === 'paused' ? 'process.exit(43)' : 'console.log("previous reconciled")') : notarget ? 'console.log("release reconciled")' : scenario === 'retry' ? `const fs=require('node:fs');const p=${JSON.stringify(join(root, 'once'))};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exit(42)}console.log('retry reconciled')` : 'process.exit(42)';
  writeFileSync(join(root, 'payload/package/dist/cotal.js'), '#!/usr/bin/env node\n' + code + '\n', { mode: 0o755 });
  assert.equal(spawnSync('tar', ['-czf', join(root, version + '.tgz'), '-C', join(root, 'payload'), 'package']).status, 0);
  archives[version] = readFileSync(join(root, version + '.tgz'));
 }
 let origin, missing = false, arriving = notarget, armed = false;
 const server = createServer((req, res) => {
  if (req.url?.endsWith('.tgz')) {
   const version = req.url.slice(1, -4);
   if (scenario === 'preflight' && version === '99.0.0') return res.writeHead(503).end();
   if (armed && arriving && version === previous) missing = true;
   return res.end(archives[version]);
  }
  const versions = Object.fromEntries(Object.entries(archives).map(([version, bytes]) => [version, { name: 'cotal-ai', version, bin: { cotal: 'dist/cotal.js' }, dist: { tarball: `${origin}/${version}.tgz`, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } }]));
  if (missing) delete versions['99.0.0'];
  res.end(JSON.stringify({ name: 'cotal-ai', 'dist-tags': { latest: '99.0.0' }, versions }));
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 origin = 'http://127.0.0.1:' + server.address().port;
 const env = { ...Object.fromEntries(Object.entries(originalEnv).filter(([key]) => !key.startsWith('COTAL_'))), HOME: home, XDG_CONFIG_HOME: join(root, 'config'), COTAL_HOME: home, npm_config_prefix: prefix, npm_config_cache: join(root, 'cache'), npm_config_registry: origin, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_TELEMETRY: 'off' };
 async function run(file, args) {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => output += bytes);
  child.stderr.on('data', bytes => output += bytes);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, output };
 }
 const command = () => run(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self']);
 const installedVersion = () => JSON.parse(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/package.json'), 'utf8')).version;
 const recovery = () => JSON.parse(readFileSync(join(home, 'update-recovery.json'), 'utf8'));
 let updater;
 try {
  if (notarget) {
   const initial = await run('npm', ['install', '-g', `cotal-ai@${previous}`]);
   assert.equal(initial.code, 0, initial.output);
   const installedPath = join(prefix, 'lib/node_modules/cotal-ai/dist/cotal.js');
   const before = readFileSync(installedPath, 'utf8');
   // A marker absent from the archive detects an unnecessary rollback reinstall.
   writeFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'unchanged');
   armed = true;
   if (scenario === 'notarget-auto') {
    Object.assign(process.env, env);
    process.chdir(root);
    const attempt = join(home, 'update-attempt.json');
    writeFileSync(attempt, JSON.stringify({ version: '99.0.0', failures: 1, result: 'due', next: 0 }));
    writeFileSync(join(home, 'update-check.json'), JSON.stringify({ v: 1, latest: '99.0.0', attemptedAt: Date.now(), checkedAt: Date.now(), firstSeenAt: Date.now() - 3601000 }));
    const { automaticUpdates } = await import('../dist/daemon/auto-update.js');
    updater = automaticUpdates({ version: previous, eligible: () => true, prepare: async () => {}, abort: async () => {}, report: () => {} });
    async function settled(expected) {
     const deadline = Date.now() + 90000;
     while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = JSON.parse(readFileSync(attempt, 'utf8'));
      if (!updater.updating() && state.result.includes(expected)) return state;
     }
     throw new Error(`scheduler did not settle: ${readFileSync(attempt, 'utf8')}`);
    }
    const deferred = await settled('not available yet');
    console.log('SCHEDULER DEFERRED:', JSON.stringify(deferred));
    assert.equal(deferred.failures, 1, 'registry lag preserves the prior failure budget');
    assert.match(deferred.result, /release is still arriving.*next update check/);
    assert.ok(deferred.next > Date.now());
    assert.equal(updater.status().automatic, true);
    assert.equal(installedVersion(), previous);
    assert.equal(readFileSync(installedPath, 'utf8'), before);
    assert.equal(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'utf8'), 'unchanged');
    assert.equal(recovery(), null);
    const log = readFileSync(join(home, 'update-attempt.log'), 'utf8');
    assert.doesNotMatch(log, /install failed|Update failed|Restoring verified/);
    arriving = missing = false;
    writeFileSync(attempt, JSON.stringify({ ...deferred, result: 'due', next: 0 }));
    updater.status();
    const completed = await settled('updated to 99.0.0');
    assert.equal(completed.failures, 0);
    assert.equal(installedVersion(), '99.0.0');
    assert.equal(recovery(), null);
   } else {
    const deferred = await command();
    console.log('MANUAL DEFERRED:', deferred.code, deferred.output.trim());
    assert.equal(deferred.code, 0, deferred.output);
    assert.match(deferred.output, /not available yet.*release is still arriving.*next update check/);
    assert.doesNotMatch(deferred.output, /install failed|Update failed|Restoring verified/);
    assert.equal(installedVersion(), previous);
    assert.equal(readFileSync(installedPath, 'utf8'), before);
    assert.equal(readFileSync(join(prefix, 'lib/node_modules/cotal-ai/preserve'), 'utf8'), 'unchanged');
    assert.equal(recovery(), null);
    arriving = missing = false;
    const completed = await command();
    assert.equal(completed.code, 0, completed.output);
    assert.equal(installedVersion(), '99.0.0');
    assert.equal(recovery(), null);
   }
  } else {
   const { code, output } = await command();
   assert.equal(code, scenario === 'retry' ? 0 : scenario === 'preflight' ? 1 : 42, output);
   if (scenario === 'preflight') assert.equal(existsSync(join(prefix, 'lib/node_modules/cotal-ai')), false, output);
   else {
    assert.equal(installedVersion(), scenario === 'retry' ? '99.0.0' : previous, output);
    if (scenario === 'paused') { assert.equal(recovery().phase, 'paused'); assert.match(output, /Automatic updates are paused/); }
    else assert.equal(recovery(), null);
   }
  }
 } finally {
  await updater?.close();
  await new Promise(resolve => server.close(resolve));
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
 }
}
emitSentinel({ passed: cells(), failed: 0 });
