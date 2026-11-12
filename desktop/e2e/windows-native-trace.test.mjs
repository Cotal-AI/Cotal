import assert from "node:assert/strict";
import { EventEmitter, errorMonitor, once } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import test from "node:test";

const source = readFileSync(new URL("./windows-native-trace.mjs", import.meta.url), "utf8");
const start = source.indexOf("function tapOwnedServiceWorker(");
const end = source.indexOf("\ntapOwnedServiceWorker(workerThreads", start);
assert.ok(start >= 0 && end > start);
const tap = runInNewContext(`(${source.slice(start, end)})`, { process: { pid: process.pid } });
const script = "/* daemonStartedByOwnedService */";
const options = () => Object.freeze({ eval: true, workerData: Object.freeze({ module: "file:///app/daemon/install.js" }) });

function fixture(record) {
  const calls = [];
  class Original extends EventEmitter {
    static marker = "static";
    threadId = 42;
    constructor(...args) { super(); calls.push({ args, newTarget: new.target }); }
  }
  const threads = { Worker: Original };
  tap(threads, errorMonitor, record);
  return { threads, Original, calls };
}

test("constructor arguments, identity, subclassing and static surface remain unchanged", () => {
  const records = [];
  const { threads, Original, calls } = fixture((r) => records.push(r));
  const opts = options();
  const extra = Object.freeze({ sentinel: true });
  const worker = new threads.Worker(script, opts, extra);
  assert.equal(calls[0].args[0], script);
  assert.equal(calls[0].args[1], opts);
  assert.equal(calls[0].args[2], extra);
  assert.equal(calls[0].newTarget, threads.Worker);
  assert.equal(threads.Worker.prototype, Original.prototype);
  assert.equal(threads.Worker.marker, Original.marker);
  assert.ok(worker instanceof Original && worker instanceof threads.Worker);
  class Derived extends threads.Worker {}
  const derived = new Derived(script, opts);
  assert.equal(calls[1].newTarget, Derived);
  assert.ok(derived instanceof Derived && derived instanceof Original);
  assert.equal(records.length, 2);
});

test("only exact target is observed and only boolean message payloads are retained", () => {
  const records = [];
  const { threads } = fixture((r) => records.push(r));
  for (const [text, opts] of [
    ["other", options()],
    [script, { eval: true, workerData: { module: "/other/install.js" } }],
    [script, { eval: false, workerData: { module: "/daemon/install.js" } }],
    [script, { eval: true, workerData: { module: "/daemon/install.js.extra" } }],
  ]) {
    const worker = new threads.Worker(text, opts);
    assert.equal(worker.listenerCount("message"), 0);
    assert.equal(worker.listenerCount(errorMonitor), 0);
    worker.emit("message", true);
    worker.emit("exit", 1);
  }
  assert.equal(records.length, 0);
  const worker = new threads.Worker(script, options());
  const seen = [];
  worker.on("message", (v) => seen.push(v));
  const privatePayload = { token: "do-not-record" };
  for (const value of [privatePayload, "secret", true, false]) worker.emit("message", value);
  worker.emit("exit", 19);
  assert.deepEqual(seen, [privatePayload, "secret", true, false]);
  assert.deepEqual(records.map((r) => r.phase), ["owned-service-worker-start", "owned-service-worker-message", "owned-service-worker-message", "owned-service-worker-exit"]);
  assert.deepEqual(records.slice(1, 3).map((r) => r.value), [true, false]);
  for (const record of records) {
    assert.equal(record.pid, process.pid);
    assert.equal(record.threadId, 42);
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(record.at)));
    assert.ok(Object.keys(record).every((key) => ["at", "phase", "pid", "threadId", "elapsedMs", "value", "exited", "exitCode"].includes(key)));
  }
  assert.ok(!JSON.stringify(records).includes("secret"));
});

test("real host worker tri-state messages retain only approved state and reason", async () => {
  const records = [];
  const threads = { Worker };
  tap(threads, errorMonitor, (r) => records.push(r));
  const payloads = [
    { state: "unknown", reason: "observation-failed", token: "private-token" },
    { state: "not-owned", reason: "marker-absent", path: "/private/source" },
    { state: "owned", reason: "verified" },
    { state: "unknown", reason: "token=private-reason" },
    { state: "private-state", reason: "verified" },
  ];
  const worker = new threads.Worker(`${script}\nfor (const value of ${JSON.stringify(payloads)}) require('node:worker_threads').parentPort.postMessage(value);`, options());
  const messages = [];
  worker.on("message", (value) => messages.push(value));
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  assert.deepEqual(messages, payloads, "the consumer receives unchanged payloads");
  const observations = records.filter((r) => r.phase === "owned-service-worker-message");
  assert.deepEqual(observations.map(({ state, reason }) => ({ state, reason })), [
    { state: "unknown", reason: "observation-failed" },
    { state: "not-owned", reason: "marker-absent" },
    { state: "owned", reason: "verified" },
  ]);
  assert.ok(!JSON.stringify(records).includes("private"));
});

test("early errors are observed without consuming unhandled errors or listener failures", () => {
  const records = [];
  const { threads } = fixture((r) => records.push(r));
  const worker = new threads.Worker(script, options());
  const error = new Error("token=private-credential");
  assert.throws(() => worker.emit("error", error), (e) => e === error);
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(records.at(-1).phase, "owned-service-worker-error");
  assert.equal(records.at(-1).error, true);
  assert.ok(!JSON.stringify(records).includes("private-credential"));
  let received;
  worker.on("error", (e) => { received = e; });
  worker.emit("error", error);
  assert.equal(received, error);
  worker.on("message", () => { throw error; });
  assert.throws(() => worker.emit("message", true), (e) => e === error);
  let exit;
  worker.on("exit", (code) => { exit = code; });
  worker.emit("exit", 7);
  assert.equal(exit, 7);
});

test("diagnostic failures do not escape and constructor failures are preserved", () => {
  const { threads } = fixture(() => { throw new Error("disk full"); });
  const worker = new threads.Worker(script, options());
  assert.doesNotThrow(() => worker.emit("message", true));
  assert.doesNotThrow(() => worker.emit("exit", 0));
  const emitted = new Error("original error");
  assert.throws(() => worker.emit("error", emitted), (error) => error === emitted);
  const error = new Error("constructor failure");
  const broken = { Worker: class { constructor() { throw error; } } };
  tap(broken, errorMonitor, () => assert.fail("must not record failed constructor"));
  assert.throws(() => new broken.Worker(script, options()), (e) => e === error);
});

test("error fields are bounded and redact token-like content without stack capture", () => {
  const records = [];
  const { threads } = fixture((r) => records.push(r));
  const worker = new threads.Worker(script, options());
  const error = new Error("cannot load module token=short-secret Bearer abcdef eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature https://user:pass@example.test " + "word ".repeat(100));
  error.code = "ERR_MODULE_NOT_FOUND";
  worker.on("error", () => {});
  worker.emit("error", error);
  const record = records.at(-1);
  assert.equal(record.errorName, "Error");
  assert.equal(record.errorCode, "ERR_MODULE_NOT_FOUND");
  assert.ok(record.errorMessage.startsWith("cannot load module"));
  assert.ok(record.errorMessage.length <= 160);
  for (const secret of ["short-secret", "abcdef", "eyJhbGci", "user:pass"]) assert.ok(!JSON.stringify(record).includes(secret));
  assert.equal(record.stack, undefined);
  worker.emit("exit", 23);
  assert.equal(records.at(-1).exitCode, 23);
});

test("real host worker lifecycle is observed without native service operations", async () => {
  const records = [];
  const threads = { Worker };
  tap(threads, errorMonitor, (r) => records.push(r));
  const worker = new threads.Worker(`${script}\nrequire('node:worker_threads').parentPort.postMessage(false);`, options());
  const messages = [];
  worker.on("message", (value) => messages.push(value));
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  assert.ok(records[0].threadId > 0);
  assert.ok(records.every((r) => r.pid === process.pid && r.threadId === records[0].threadId));
  assert.deepEqual(messages, [false]);
  assert.deepEqual(records.map((r) => r.phase), ["owned-service-worker-start", "owned-service-worker-message", "owned-service-worker-exit"]);
});

test("wrapper synchronizes builtin exports after tap and before unchanged entry import", () => {
  assert.ok(source.indexOf("tapOwnedServiceWorker(workerThreads") < source.indexOf("syncBuiltinESMExports();"));
  assert.ok(source.indexOf("syncBuiltinESMExports();") < source.indexOf("await import(pathToFileURL(process.argv[1]).href)"));
});

test("real host worker early failure reaches the consumer and is followed by exit", async () => {
  const records = [];
  const threads = { Worker };
  tap(threads, errorMonitor, (r) => records.push(r));
  const worker = new threads.Worker(`${script}\nthrow new Error('token=private-failure');`, options());
  let received;
  worker.on("error", (error) => { received = error; });
  const code = await new Promise((resolve) => worker.once("exit", resolve));
  assert.equal(code, 1);
  assert.equal(received.message, "token=private-failure");
  assert.equal(records.at(-1).exitCode, 1);
  assert.deepEqual(records.map((r) => r.phase), ["owned-service-worker-start", "owned-service-worker-error", "owned-service-worker-exit"]);
  assert.ok(!JSON.stringify(records).includes("private-failure"));
});
