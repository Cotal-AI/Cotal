import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Intel account status still fails at its original deadline or a premature EOF with byte evidence', () => {
  const fixture = read('../../bin/smoke/daemon-service-connect.smoke.ts');
  const ask = fixture.slice(fixture.indexOf('async function ask('), fixture.indexOf('const resultOf'));
  assert.match(ask, /observe\?\.\("sending", \{ id \}\);\s*sock\.write/);
  assert.match(ask, /observe\?\.\("deadline", \{ id, bytes: Buffer\.byteLength\(buf\) \}\)/);
  assert.match(ask, /connection closed by daemon before reply to \$\{id\}; received \$\{bytes\} bytes/);
  assert.match(ask, /sock\.once\("end", \(\) => peerClosed\("peer-ended"\)\)/);
  assert.match(ask, /sock\.once\("close", hadError => peerClosed\("closed", hadError\)\)/);
  assert.match(fixture, /ask\(desktopSocket, \{ op: "status" \}, 10_000, observe\)/);
  assert.match(fixture, /process\.platform === "darwin" && process\.arch === "x64" && process\.env\.RUNNER_TEMP/);
  assert.match(fixture, /phase, \.\.\.facts, daemonLogBytes, daemonLogInode/);
});

test('Intel credential-drop offsets come from the same owned log and a bounded tail read', () => {
  const journey = read('./first-run.ts');
  assert.match(journey, /fixture\.account\.enable\(join\(daemonHome, "daemon\.log"\)\)/);
  const grade = journey.slice(journey.indexOf('const fd = openSync(join(daemonHome, "daemon.log")'), journey.indexOf('"intel-account-peer-drop-offsets.json"'));
  assert.match(grade, /fstatSync\(fd\)/);
  assert.match(grade, /Math\.max\(0, size - 64 \* 1024\)/);
  assert.match(grade, /offsets\.push\(start \+ index\)/);
  assert.match(journey, /JSON\.stringify\(\{ ino, size, start, count, offsets \}\)/);
});
