import assertions from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { countedAssert, emitSentinel, skipSuite } from './sentinel.mjs';

if (!['linux', 'darwin'].includes(process.platform)) skipSuite('POSIX global update child recovery');
const counted = countedAssert(assertions), assert = counted.assert;

// Keep the installed entry, npm cache and logs for the interrupted command's evidence.
const repo = resolve(import.meta.dirname, '../..');
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
  for (const scenario of ['control', 'interrupted']) {
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
    const child = spawn(process.execPath, [join(repo, 'bin/dist/cotal.js'), 'update', '--self'], { cwd: cell, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => output += bytes);
    child.stderr.on('data', bytes => output += bytes);
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    writeFileSync(join(cell, 'update.log'), output);
    console.log(`${scenario} exit ${code}\n${output}`);
    assert.equal(code, 0, `${scenario}: plain self-update must recover its interrupted reconcile`);
    assert.match(output, scenario === 'control' ? /installed globally and reconciled/ : /repaired and reconciled/);
    assert.equal(existsSync(join(cell, 'prefix/lib/node_modules/.cotal-update-child')), false);
    assert.equal(JSON.parse(readFileSync(join(cell, 'cotal/update-recovery.json'), 'utf8')), null);
    if (scenario === 'interrupted') {
      assert.equal(existsSync(join(cell, 'cotal/interrupted-once')), true);
      assert.match(output, /Retrying reconciliation/);
    }
  }
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await new Promise(done => server.close(done)); }
