import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./launch.ts', import.meta.url), 'utf8');

test('installed entitlement assertion accepts codesign output forms and rejects a missing key', () => {
  const assertion = source.split('\n').find(line => line.includes('assert.match(entitlements,'));
  assert.ok(assertion);
  for (const entitlements of [
    '<dict><key>com.apple.security.cs.allow-jit</key><true/></dict>',
    '[Dict]\n\t[Key] com.apple.security.cs.allow-jit\n\t[Value]\n\t\t[Bool] true',
  ]) runInNewContext(assertion, { assert, entitlements });
  assert.throws(() => runInNewContext(assertion, { assert, entitlements: '[Dict]' }), { code: 'ERR_ASSERTION' });
});

test('installed macOS client executes the shipped signature and its own Node and CLI', () => {
  const start = source.indexOf('const installed = "/Applications/Cotal.app"');
  const end = source.indexOf('} else if (process.platform === "win32")', start);
  const mac = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(mac, /assert\.ok\(!existsSync\(installed\)/);
  assert.match(mac, /run\("ditto", \[join\(mount, apps\[0\]\), installed\]\)/);
  assert.ok(mac.includes('run("codesign", ["--verify", "--deep", "--strict", installed])'));
  assert.doesNotMatch(mac, /--force|--sign|--preserve-metadata/);
  assert.ok(mac.includes('const node = join(installed, "Contents/MacOS/cotal-node")'));
  assert.ok(mac.includes('const cli = join(installed, "Contents/Resources/runtime/dist/cotal.js")'));
  assert.ok(mac.includes('assert.equal(realpathSync(node), node'));
  assert.ok(mac.includes('assert.equal(realpathSync(cli), cli'));
  assert.ok(mac.includes('["-d", "--entitlements", "-", node]'));
  assert.match(mac, /com\\\.apple\\\.security\\\.cs\\\.allow-jit/);
  assert.ok(mac.includes('const args = [cli, "daemon", "status", "--json"]'));
  assert.ok(mac.includes('spawnSync(node, args, { env, cwd: env.HOME'));
  for (const assertion of ['status.status, 2', 'status.signal, null', 'answer.schemaVersion, 1', 'answer.command, "daemon status"', 'answer.completeness, "not-checked"', 'answer.outcome, "refused"', 'answer.result, null', 'answer.error?.code, "TARGET_UNAVAILABLE"', 'answer.error?.cause?.code, "NOT_RUNNING"']) assert.ok(mac.includes(assertion), assertion);
  assert.ok(mac.includes('"applications-daemon-status.json"'));
  assert.ok(mac.includes('"applications-node-entitlements.plist"'));
  assert.ok(mac.indexOf('spawnSync(node, args') < mac.indexOf('targets.push('));
});
