import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
test('copy observer counts original operations and preserves copied bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'copy-throughput-'));
  const source = join(root, 'source'), destination = join(root, 'copy'), output = join(root, 'trace');
  mkdirSync(join(source, 'nested'), { recursive: true }); mkdirSync(output);
  writeFileSync(join(source, 'one'), '123'); writeFileSync(join(source, 'nested/two'), '4567');
  const script = `const fs=require('node:fs'); function addTransaction(){fs.cpSync(${JSON.stringify(source)},${JSON.stringify(destination)},{recursive:true,verbatimSymlinks:true});} addTransaction();`;
  const child = spawnSync(process.execPath, ['--require', resolve('scripts/update-copy-throughput.cjs'), '-e', script], { env: { ...process.env, COPY_THROUGHPUT_DIR: output }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(join(destination, 'nested/two'), 'utf8'), '4567');
  const rows = readdirSync(output).flatMap(name => readFileSync(join(output, name), 'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(rows.length, 1); assert.equal(rows[0].files, 2); assert.equal(rows[0].bytes, 7);
  assert(rows[0].durationMs >= 0); assert.equal(rows[0].countMethod, 'destination scan after timed original call');
});
