import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installWindowsPeerTrace, withoutPeerTraceImport } from "./windows-peer-trace.mjs";

function fixture(run) {
  const dir = fs.mkdtempSync(join(tmpdir(), "peer-trace-"));
  const lockPath = join(dir, "daemon.lock");
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const result = run(lockPath);
    if (result?.then) return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) { cleanup(); throw error; }
}

test("preserves native receiver, args, promise, result and exact client read", async () => {
  await fixture(async lockPath => {
    const raw = '{"v":1,"pid":42,"start":"90071992547409931"}\r\n';
    fs.writeFileSync(lockPath, raw);
    const peer = Object.freeze({ pid: 42, birth: "90071992547409931", fd: 123, user: "not-retained" });
    const promise = Promise.resolve(peer), records = [];
    const native = { pipeConnect(...args) { assert.equal(this, native); assert.deepEqual(args, ["fixture-pipe", 55]); return promise; } };
    const stdout = { write() { return true; } };
    const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath, stdout, record: r => records.push(r) });
    try {
      assert.equal(native.pipeConnect("fixture-pipe", 55), promise);
      assert.equal(await promise, peer);
      assert.equal(fs.readFileSync(lockPath, "utf8"), raw);
      assert.equal(records[0].phase, "pipe-connected");
      assert.deepEqual(records[0].peer, { pid: 42, birth: peer.birth });
      assert.equal(records[1].bytesBase64, Buffer.from(raw).toString("base64"));
      assert.equal(records[1].byteSource, "client-string");
      stdout.write('{"error":{"code":"PEER_NOT_LOCK_OWNER"}}\n');
      assert.equal(records[2].afterAttempt, records[0].attempt);
      assert.equal(records[2].afterRead, records[1].read);
      assert.equal(records[2].pid, process.pid);
      assert.ok(Number.isFinite(Date.parse(records[2].at)));
      assert.equal(JSON.stringify(records).includes("not-retained"), false);
    } finally { stop(); }
  });
});

test("preserves throws, rejections, read errors and ignores unrelated paths", async () => {
  await fixture(async lockPath => {
    const error = Object.assign(new Error("private"), { code: "ENOENT" });
    let mode = "throw";
    const native = { pipeConnect() { if (mode === "throw") throw error; return Promise.reject(error); } };
    const original = native.pipeConnect, read = fs.readFileSync, records = [];
    const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath, record: r => records.push(r) });
    try {
      assert.throws(() => native.pipeConnect("fixture-pipe"), e => e === error);
      mode = "reject";
      await assert.rejects(native.pipeConnect("other"), e => e === error);
      assert.equal(records.length, 1);
      await assert.rejects(native.pipeConnect("fixture-pipe"), e => e === error);
      assert.throws(() => fs.readFileSync(lockPath, "utf8"), { code: "ENOENT" });
      assert.equal(records.at(-1).phase, "lock-read-error");
      fs.readFileSync(import.meta.filename);
      assert.equal(records.length, 3);
      assert.equal(JSON.stringify(records).includes("private"), false);
    } finally { stop(); }
    assert.equal(native.pipeConnect, original);
    assert.equal(fs.readFileSync, read);
  });
});

test("diagnostic writer failure cannot affect consumers or stdout", async () => {
  await fixture(async lockPath => {
    fs.writeFileSync(lockPath, "bytes");
    const peer = { pid: 1, birth: "2" }, promise = Promise.resolve(peer);
    const native = { pipeConnect() { return promise; } };
    const calls = [], stdout = { write(...args) { calls.push({ receiver: this, args }); return false; } };
    const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath, stdout, record() { throw new Error("disk full"); } });
    try {
      assert.equal(await native.pipeConnect("fixture-pipe"), peer);
      assert.equal(fs.readFileSync(lockPath, "utf8"), "bytes");
      const callback = () => {};
      assert.equal(stdout.write('{"error":{"code":"PEER_NOT_LOCK_OWNER"}}\n', callback), false);
      assert.equal(calls[0].receiver, stdout);
      assert.equal(calls[0].args[1], callback);
    } finally { stop(); }
  });
});

test("split refusal frames retain only receipt coordinates, never frame data", () => {
  fixture(lockPath => {
    const records = [], error = new Error("stdout failure");
    const stdout = { write(chunk) { if (chunk === "throw") throw error; return true; } };
    const native = { pipeConnect() {} };
    const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath, stdout, record: r => records.push(r) });
    try {
      stdout.write("malformed\n");
      stdout.write('{"error":{"code":"PEER_NOT_');
      stdout.write('LOCK_OWNER","message":"secret"}}\n');
      assert.equal(records[0].phase, "client-refusal");
      assert.equal(records[0].code, "PEER_NOT_LOCK_OWNER");
      assert.equal(JSON.stringify(records).includes("secret"), false);
      assert.throws(() => stdout.write("throw"), e => e === error);
    } finally { stop(); }
  });
});

test("throwing identity and error getters never replace native outcomes", async () => {
  const error = { get code() { throw new Error("getter"); } };
  const peer = { get pid() { throw error; } };
  const native = { pipeConnect() { return Promise.resolve(peer); } };
  const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath: "fixture-lock", record() {} });
  try { assert.equal(await native.pipeConnect("fixture-pipe"), peer); } finally { stop(); }
  native.pipeConnect = () => Promise.reject(error);
  const stop2 = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath: "fixture-lock", record() {} });
  try { await assert.rejects(native.pipeConnect("fixture-pipe"), e => e === error); } finally { stop2(); }
});

test("wrapped refusals require exact fixture coordinates and reads are bounded", () => {
  fixture(lockPath => {
    fs.writeFileSync(lockPath, Buffer.alloc(5000, 65));
    const records = [], stdout = { write() { return true; } }, native = { pipeConnect() {} };
    const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath, stdout, record: r => records.push(r) });
    try {
      const bytes = fs.readFileSync(lockPath);
      assert.equal(bytes.length, 5000);
      assert.equal(records[0].truncated, true);
      assert.equal(records[0].byteSource, "buffer");
      assert.equal(Buffer.from(records[0].bytesBase64, "base64").length, 4096);
      stdout.write(JSON.stringify({ error: { code: "OPERATION_UNKNOWN", message: "other" } }) + "\n");
      assert.equal(records.length, 1);
      stdout.write(JSON.stringify({ error: { code: "OPERATION_UNKNOWN", message:
        `the process answering at fixture-pipe is not the daemon holding ${lockPath}; nothing was sent` } }) + "\n");
      assert.equal(records[1].phase, "client-refusal");
      assert.equal(records[1].wrappedCode, "OPERATION_UNKNOWN");
      assert.equal(records[1].afterRead, records[0].read);
    } finally { stop(); }
  });
});

test("removes only exact self loader coordinate and preserves other flags", () => {
  const url = "file:///fixture/windows-peer-trace.mjs";
  for (const token of [`--import=${url}`, `--import ${url}`, `--import="${url}"`]) {
    assert.equal(withoutPeerTraceImport(`--trace-warnings ${token} --import=file:///other.mjs`, url), "--trace-warnings  --import=file:///other.mjs");
  }
  assert.equal(withoutPeerTraceImport(`--import=${url}.other`, url), `--import=${url}.other`);
});

test("missing native pipe export fails without inventing an export or patching readers", () => {
  const native = {}, stdout = { write() {} }, records = [];
  const before = Object.getOwnPropertyDescriptors(native), read = fs.readFileSync, write = stdout.write;
  assert.equal(installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath: "fixture-lock", stdout,
    record: receipt => records.push(receipt) }), undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(native), before);
  assert.equal(fs.readFileSync, read);
  assert.equal(stdout.write, write);
  assert.equal(records[0].stage, "patch-native");
  assert.equal(records[0].errorCode, "ERR_PEER_TRACE_UNSUPPORTED");
});

test("native and writer descriptors survive installation, rollback and uninstall", () => {
  for (const writable of [true, false]) {
    const native = {}, stdout = { write() { return true; } }, records = [];
    Object.defineProperty(native, "pipeConnect", { value() {}, writable, configurable: false, enumerable: false });
    const before = Object.getOwnPropertyDescriptors(native);
    const read = Object.getOwnPropertyDescriptor(fs, "readFileSync"), write = Object.getOwnPropertyDescriptor(stdout, "write");
    const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath: "fixture-lock", stdout,
      record: receipt => records.push(receipt) });
    if (writable) {
      assert.equal(typeof stop, "function");
      assert.deepEqual({ ...Object.getOwnPropertyDescriptor(native, "pipeConnect"), value: before.pipeConnect.value }, before.pipeConnect);
      stop();
    } else {
      assert.equal(stop, undefined);
      assert.equal(records[0].phase, "peer-trace-install-failed");
      assert.equal(records[0].stage, "patch-native");
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(native), before);
    assert.deepEqual(Object.getOwnPropertyDescriptor(fs, "readFileSync"), read);
    assert.deepEqual(Object.getOwnPropertyDescriptor(stdout, "write"), write);
  }
});

test("uninstall removes only its inherited-writer shadow and retains later wrappers", () => {
  const prototype = { write() { return true; } }, stdout = Object.create(prototype);
  const native = { pipeConnect() {} };
  const stop = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath: "fixture-lock", stdout, record() {} });
  assert.equal(Object.hasOwn(stdout, "write"), true);
  stop();
  assert.equal(Object.hasOwn(stdout, "write"), false);
  assert.equal(stdout.write, prototype.write);
  const stop2 = installWindowsPeerTrace({ native, pipePath: "fixture-pipe", lockPath: "fixture-lock", stdout, record() {} });
  const later = () => false;
  stdout.write = later;
  stop2();
  assert.equal(stdout.write, later);
});
