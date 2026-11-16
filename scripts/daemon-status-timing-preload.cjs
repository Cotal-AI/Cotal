'use strict';
// Harness only. No payloads, paths, or product state are recorded.
const fs = require('node:fs');
const moduleApi = require('node:module');
const net = require('node:net');
const file = process.env.COTAL_STATUS_TIMING_FILE;
const ownOption = `--require=${JSON.stringify(__filename)}`;
delete process.env.COTAL_STATUS_TIMING_FILE;
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '').replace(ownOption, '').trim();
if (!file || typeof moduleApi.registerHooks !== 'function') throw new Error('status timing requires evidence path and Node registerHooks');
const fd = fs.openSync(file, 'a');
let count = 0;
function record(stage) {
  if (count++ >= 32) return;
  try { fs.writeSync(fd, JSON.stringify({ stage, pid: process.pid, at: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString() }) + '\n'); }
  catch { /* Observation failure is detected by the parent, never thrown into product code. */ }
}
record('preload-ready');
const seen = new Set();
moduleApi.registerHooks({ load(url, context, nextLoad) {
  const name = /\/(cotal-program|daemon\/client)\.(?:js|ts)$/.exec(url)?.[1];
  if (!name || seen.has(name)) return nextLoad(url, context);
  seen.add(name);
  record(`${name}:load-hook-start`);
  try { return nextLoad(url, context); }
  finally { record(`${name}:load-hook-return`); }
} });
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node normalizes net.connect(path) into [options, callback]. Only Unix sockets.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof options === 'string' ? options : options?.path;
  if (typeof path === 'string' && path.endsWith('/daemon.sock')) {
    record('daemon-socket-connect-call');
    const emit = this.emit;
    const observed = new Set();
    this.emit = function (event, ...values) {
      if (['connect', 'data', 'close', 'error'].includes(event) && !observed.has(event)) {
        observed.add(event);
        record(`daemon-socket-first-${event}`);
      }
      return Reflect.apply(emit, this, [event, ...values]);
    };
    const result = Reflect.apply(connect, this, args);
    const write = this.write;
    this.write = function (...values) {
      if (!observed.has('write')) { observed.add('write'); record('daemon-socket-first-write-call'); }
      return Reflect.apply(write, this, values);
    };
    return result;
  }
  return Reflect.apply(connect, this, args);
};
process.once('exit', () => { record('child-exit'); try { fs.closeSync(fd); } catch { /* Parent verifies evidence. */ } });
