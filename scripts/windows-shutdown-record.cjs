/* Measurement only. Forward original calls and results without extra connects or lock reads. */
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const Module = require('node:module');
const path = require('node:path');
const output = path.join(__dirname, 'shutdown-records');
fs.mkdirSync(output, { recursive: true });
const append = fs.appendFileSync.bind(fs);
const pending = [];
const descriptors = new Map();
const peers = new Map();
let scheduled = false;
let sequence = 0;
function flush() {
  scheduled = false;
  if (pending.length) append(path.join(output, `${process.pid}.jsonl`), pending.splice(0).join(''));
}
function record(event, fields = {}) {
  pending.push(JSON.stringify({ time: new Date().toISOString(), monotonic: process.hrtime.bigint().toString(), pid: process.pid, sequence: ++sequence, event, ...fields }) + '\n');
  if (!scheduled) { scheduled = true; setImmediate(flush).unref(); }
}
function lockName(value) { return typeof value === 'string' && /[\\/]daemon\.lock$/.test(value); }
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  try {
    const result = Reflect.apply(read, this, [file, ...args]);
    if (lockName(file)) record('lock-read', { path: file, size: Buffer.byteLength(result), bytes: String(result) });
    return result;
  } catch (error) {
    if (lockName(file)) record('lock-read-error', { path: file, code: error.code });
    throw error;
  }
};
const open = fs.openSync;
fs.openSync = function(file, ...args) {
  const fd = Reflect.apply(open, this, [file, ...args]);
  if (lockName(file)) descriptors.set(fd, file);
  return fd;
};
const truncate = fs.ftruncateSync;
fs.ftruncateSync = function(fd, length = 0) {
  const result = Reflect.apply(truncate, this, [fd, length]);
  if (descriptors.has(fd)) record('lock-truncate', { path: descriptors.get(fd), size: length });
  return result;
};
const close = fs.closeSync;
fs.closeSync = function(fd) {
  const result = Reflect.apply(close, this, [fd]);
  if (descriptors.has(fd)) { record('lock-close', { path: descriptors.get(fd) }); descriptors.delete(fd); }
  if (peers.has(fd)) { record('pipe-fd-close', { fd, peer: peers.get(fd) }); peers.delete(fd); }
  return result;
};
const extension = Module._extensions['.node'];
Module._extensions['.node'] = function(module, filename) {
  Reflect.apply(extension, this, [module, filename]);
  const native = module.exports;
  if (!filename.endsWith('peercred.node') || typeof native.pipeConnect !== 'function') return;
  for (const name of ['pipeConnect', 'pipeAccept']) {
    const original = native[name];
    native[name] = function(...args) {
      const started = new Date().toISOString();
      return Reflect.apply(original, this, args).then(result => {
        const peer = { pid: result.pid, birth: result.birth, user: result.user };
        if (result.fd !== undefined) peers.set(result.fd, peer);
        record(name, { started, code: result.refused ? 'REFUSED' : 'OK', peer, fd: result.fd, ...(name === 'pipeConnect' ? { pipe: args[0] } : {}) });
        return result;
      }, error => {
        record(name, { started, code: error.code, syscall: error.syscall });
        throw error;
      });
    };
  }
  const pipeClose = native.pipeClose;
  native.pipeClose = function(...args) {
    record('listener-close-start');
    const result = Reflect.apply(pipeClose, this, args);
    record('listener-close-return');
    return result;
  };
};
const destroy = net.Socket.prototype.destroy;
net.Socket.prototype.destroy = function(...args) {
  const fd = this._handle?.fd;
  if (peers.has(fd) && !this.__shutdownRecorded) {
    this.__shutdownRecorded = true;
    const peer = peers.get(fd);
    record('socket-destroy', { fd, peer });
    this.once('close', () => { record('socket-close', { fd, peer }); peers.delete(fd); });
  }
  return Reflect.apply(destroy, this, args);
};
Module.syncBuiltinESMExports();
record('start', { node: process.version, verb: process.argv[3] });
process.once('exit', code => { record('exit', { code }); flush(); });
