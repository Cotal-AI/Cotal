import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Mac account status still fails at its original deadline or a premature EOF with byte evidence', () => {
  const fixture = read('../../bin/smoke/daemon-service-connect.smoke.ts');
  const ask = fixture.slice(fixture.indexOf('async function ask('), fixture.indexOf('const resultOf'));
  assert.match(ask, /observe\?\.\("sending", \{ id \}\);\s*sock\.write/);
  assert.match(ask, /observe\?\.\("deadline", \{ id, bytes: Buffer\.byteLength\(buf\) \}\)/);
  assert.match(ask, /connection closed by daemon before reply to \$\{id\}; received \$\{bytes\} bytes/);
  assert.match(ask, /sock\.once\("end", \(\) => peerClosed\("peer-ended"\)\)/);
  assert.match(ask, /sock\.once\("close", hadError => peerClosed\("closed", hadError\)\)/);
  assert.match(fixture, /last = await ask\(desktopSocket, \{ op: "status" \}, 10_000, observe &&/);
  assert.match(fixture, /process\.platform === "darwin" && process\.env\.RUNNER_TEMP/);
  assert.match(fixture, /stopControl = control\.startMacStatusControl\(desktopSocket, id, 8_000,/);
  assert.match(fixture, /finally \{\s*if \(trigger !== undefined\) clearTimeout\(trigger\);\s*stopControl\?\.\(\);/);
  assert.match(fixture, /phase, \.\.\.facts, daemonLogBytes, daemonLogInode/);
});

test('Mac credential-drop offsets come from the same owned log and a bounded tail read', () => {
  const journey = read('./first-run.ts');
  assert.match(journey, /fixture\.account\.enable\(join\(daemonHome, "daemon\.log"\)\)/);
  const grade = journey.slice(journey.indexOf('const fd = openSync(join(daemonHome, "daemon.log")'), journey.indexOf('"mac-account-peer-drop-offsets.json"'));
  assert.match(grade, /fstatSync\(fd\)/);
  assert.match(grade, /Math\.max\(0, size - 64 \* 1024\)/);
  assert.match(grade, /offsets\.push\(start \+ index\)/);
  assert.match(journey, /JSON\.stringify\(\{ ino, size, start, count, offsets \}\)/);
});

test('plain status control independently records a valid reply or an early EOF', async t => {
  const root = mkdtempSync(join(tmpdir(), 'status-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { startMacStatusControl } = await tsImport('./mac-status-control.ts', import.meta.url);
  for (const answer of [true, false]) {
    let request;
    const server = createServer(socket => {
      socket.setEncoding('utf8');
      let body = '';
      socket.on('data', chunk => {
        body += chunk;
        if (!body.includes('\n')) return;
        request = JSON.parse(body);
        socket.end(answer ? JSON.stringify({ v: 1, id: request.id, ok: true, result: { notRetained: true } }) + '\n' : 'partial');
      });
    });
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cotal-control-${process.pid}-${answer}` : join(root, `${answer}.sock`);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    try {
      const events = [];
      const result = await new Promise(resolve => {
        startMacStatusControl(endpoint, 'control-test', 1000, event => {
          events.push(event);
          if (event.phase !== 'control-start' && event.phase !== 'control-send') resolve(event);
        });
      });
      assert.deepEqual(request, { v: 1, id: 'control-test', op: 'status' });
      assert.deepEqual(events.slice(0, 2).map(event => event.phase), ['control-start', 'control-send']);
      assert.equal(result.phase, answer ? 'control-reply' : 'control-eof');
      assert.equal(result.ok, answer ? true : undefined);
      assert.ok(result.bytes > 0);
      assert.doesNotMatch(JSON.stringify(events), /notRetained|partial/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
