import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('passive observer preserves output, child exit, filesystem calls and descendants', () => {
  const root = mkdtempSync(join(tmpdir(), 'update-duration-observer-'));
  const trace = join(root, 'trace');
  mkdirSync(trace);
  const script = join(root, 'cotal.js');
  writeFileSync(script, `
    const {spawnSync, spawn} = require('node:child_process');
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(join(root, 'payload'))}, 'payload');
    if (fs.readFileSync(${JSON.stringify(join(root, 'payload'))}, 'utf8') !== 'payload') throw Error('filesystem changed');
    const child = spawnSync(process.execPath, ['-e', 'console.log("child");process.exitCode=7'], {encoding:'utf8'});
    if (child.status !== 7 || child.stdout !== 'child\\n') throw Error('child result changed');
    process.stdout.write(child.stdout);
    process.stderr.write('warning\\n');
    spawn(process.execPath, ['-e', 'process.stdout.write("async\\\\n")'], {stdio:'inherit'}).once('close', code => { process.exitCode = code; });
  `);
  const run = env => spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  const plain = run({ ...process.env, NODE_OPTIONS: '' });
  const observed = run({ ...process.env, UPDATE_TIMING_DIR: trace, NODE_OPTIONS: `--require=${JSON.stringify(resolve('scripts/update-duration-observer.cjs'))}` });
  assert.equal(observed.status, plain.status);
  assert.equal(observed.stdout, plain.stdout);
  assert.equal(observed.stderr, plain.stderr);
  assert.equal(observed.status, 0);
  const events = readdirSync(trace).flatMap(name => readFileSync(join(trace, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(events.filter(e => e.kind === 'process-start').length, 3);
  const starts = events.filter(e => e.kind === 'child-start');
  assert.equal(starts.length, 2);
  for (const start of starts) {
    const end = events.find(e => e.kind === 'child-end' && e.id === start.id);
    assert(end && end.at >= start.at);
  }
  assert(events.some(e => e.kind === 'child-end' && e.status === 7));
  assert(events.some(e => e.kind === 'filesystem-group' && e.api === 'readFileSync' && e.calls > 0));
  assert(events.some(e => e.kind === 'output' && e.text === 'warning\n'));
});
