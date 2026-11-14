import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const Module = require('node:module');
const output = new URL('./shutdown-records/', import.meta.url);
let connects = 0;
let accepts = 0;
let closes = 0;
const identity = { fd: 900001, pid: 42, birth: '134391112243773008', user: 'S-1-5-21-1' };
const failure = Object.assign(new Error('absent'), { code: 'ENOENT', syscall: 'CreateFileW' });
const originalExtension = Module._extensions['.node'];
Module._extensions['.node'] = module => { module.exports = {
  pipeConnect: () => { connects++; return connects === 1 ? Promise.resolve(identity) : Promise.reject(failure); },
  pipeAccept: () => { accepts++; return Promise.resolve(identity); },
  pipeClose: () => { closes++; },
}; };
require('./windows-shutdown-record.cjs');
const module = {};
Module._extensions['.node'](module, 'peercred.node');
assert.equal(await module.exports.pipeConnect('pipe', 1000), identity);
await assert.rejects(module.exports.pipeConnect('pipe', 1000), error => error === failure);
assert.equal(await module.exports.pipeAccept({}), identity);
assert.equal(module.exports.pipeClose({}), undefined);
assert.deepEqual({ connects, accepts, closes }, { connects: 2, accepts: 1, closes: 1 });
const base = join(process.env.TMPDIR, 'recorder-control');
mkdirSync(base);
const lock = join(base, 'daemon.lock');
writeFileSync(lock, 'original');
assert.equal(fs.readFileSync(lock, 'utf8'), 'original');
const fd = fs.openSync(lock, 'r+');
fs.ftruncateSync(fd, 0);
fs.closeSync(fd);
await new Promise(resolve => setImmediate(resolve));
Module._extensions['.node'] = originalExtension;
const files = readdirSync(output);
assert.ok(files.includes(`${process.pid}.jsonl`));
const rows = readFileSync(new URL(`${process.pid}.jsonl`, output), 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.filter(row => row.event === 'pipeConnect').length, 2);
assert.equal(rows.filter(row => row.event === 'lock-read').length, 1);
assert.equal(rows.find(row => row.event === 'lock-read').bytes, 'original');
assert.equal(rows.filter(row => row.event === 'lock-truncate').length, 1);
console.log('Recorder control passed: same results and errors, 2 original connects, 1 original lock read. This is not Windows reproduction.');
