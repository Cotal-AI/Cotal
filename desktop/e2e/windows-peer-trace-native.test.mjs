import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire, findPackageJSON, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { installWindowsPeerTrace, installWindowsPeerTraceFromContext } from "./windows-peer-trace.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const repoCli = join(repo, "bin/dist/cotal.js");
const fixtureRoot = process.env.PEER_TRACE_NATIVE_FIXTURE_ROOT;
const bundledRuntime = process.env.PEER_TRACE_BUNDLED_RUNTIME;

async function fixture(layout, run) {
  const root = fs.mkdtempSync(join(fixtureRoot, "native-"));
  // Exercise the prepared application closure itself, including its transitive dependencies.
  // Never assemble a second package graph or a second native-helper cache for these tests.
  await run(root, layout === "repo" ? repoCli : join(bundledRuntime, "dist/cotal.js"));
}

async function helper(cliPath) {
  const packagePath = findPackageJSON("@cotal-ai/seat", pathToFileURL(cliPath));
  const module = await import(pathToFileURL(join(dirname(packagePath), "dist/peercred.js")).href);
  return module.loadNativeHelper();
}

function receipts(output) {
  return fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
}

if (!fixtureRoot) {
  test("real helper context and Windows pipe integrations in an isolated process", { timeout: 90000 }, t => {
    const root = fs.mkdtempSync(join(tmpdir(), "peer-native-"));
    try {
      const env = { ...process.env, PEER_TRACE_NATIVE_FIXTURE_ROOT: root };
      delete env.NODE_TEST_CONTEXT;
      // node:test's isolated child transport writes binary result frames to stdout.
      // Run as an ordinary script so the trace sees the same stdout as the real CLI.
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env, encoding: "utf8", timeout: 80000,
      });
      t.diagnostic(child.stdout);
      if (child.stderr) t.diagnostic(child.stderr);
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0);
    } finally {
      // Loaded native DLLs are no longer held by the child when the parent removes its fixture.
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
} else {
if (process.platform === "win32" || bundledRuntime) {
  assert.ok(bundledRuntime, "PEER_TRACE_BUNDLED_RUNTIME must name the prepared application runtime");
  const manifest = JSON.parse(fs.readFileSync(join(bundledRuntime, "desktop-runtime.json"), "utf8"));
  const version = JSON.parse(fs.readFileSync(join(repo, "bin/package.json"), "utf8")).version;
  assert.equal(manifest.version, version, "prepared runtime must match the repository CLI");
  assert.ok(fs.existsSync(join(bundledRuntime, "dist/cotal.js")));
}
for (const layout of ["repo", "bundled"]) {
  const missingBundle = layout === "bundled" && !bundledRuntime ? "No prepared application closure on this host. Bundled integration remains pending." : false;
  test(`${layout} actual context resolves the ESM-only seat and built native helper`, { skip: missingBundle }, async t => {
    await fixture(layout, async (root, cliPath) => {
      // This is the pre-fix failure, with the real manifest, not a mocked package surface.
      assert.throws(() => createRequire(pathToFileURL(cliPath)).resolve("@cotal-ai/seat"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
      const native = await helper(cliPath);
      const { queryDaemon } = await import(pathToFileURL(join(dirname(cliPath), "daemon/client.js")).href);
      assert.equal(typeof queryDaemon, "function", "real stock endpoint client loads from this context");
      const before = Object.getOwnPropertyDescriptors(native);
      const read = Object.getOwnPropertyDescriptor(fs, "readFileSync");
      const write = Object.getOwnPropertyDescriptor(process.stdout, "write");
      const output = join(root, "receipts.jsonl");
      let stop;
      try {
        stop = await installWindowsPeerTraceFromContext({ cliPath, pipe: "fixture-pipe", lock: join(root, "daemon.lock"), output });
        const found = receipts(output);
        if (process.platform === "win32") {
          assert.equal(typeof stop, "function");
          assert.equal(found[0].phase, "peer-trace-installed");
          assert.notEqual(native.pipeConnect, before.pipeConnect.value);
          assert.deepEqual({ ...Object.getOwnPropertyDescriptor(native, "pipeConnect"), value: before.pipeConnect.value }, before.pipeConnect);
        } else {
          assert.equal(typeof native.peercred, "function");
          assert.equal(stop, undefined);
          assert.equal(found.length, 1);
          assert.equal(found[0].phase, "peer-trace-install-failed");
          assert.equal(found[0].stage, "patch-native");
          assert.equal(found[0].errorCode, "ERR_PEER_TRACE_UNSUPPORTED");
          t.diagnostic("Real native helper loaded, but no pipeConnect exists on this platform. Windows peer receipt proof remains pending.");
        }
        assert.equal(JSON.stringify(found).includes(root), false, "no arbitrary paths in install receipts");
      } finally { stop?.(); }
      assert.deepEqual(Object.getOwnPropertyDescriptors(native), before);
      assert.deepEqual(Object.getOwnPropertyDescriptor(fs, "readFileSync"), read);
      assert.deepEqual(Object.getOwnPropertyDescriptor(process.stdout, "write"), write);
    });
  });

  test(`${layout} actual CLI stdout records the stock endpoint refusal without test transport frames`, { skip: missingBundle, timeout: 30000 }, async t => {
    await fixture(layout, async (root, cliPath) => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./windows-peer-trace-cli.mjs", import.meta.url)), root, cliPath], {
        env, encoding: "utf8", timeout: 25000,
      });
      t.diagnostic(child.stdout);
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      const proof = JSON.parse(child.stdout);
      assert.equal(proof.cliRefusal, "PEER_NOT_LOCK_OWNER");
      assert.equal(proof.connections, 1);
      assert.equal(proof.lockReads, 1);
      assert.equal(proof.requestBytes, 0);
    });
  });

  test(`${layout} real Windows native pipe retains the original promise, peer and descriptor`, { skip: missingBundle || process.platform !== "win32", timeout: 15000 }, async () => {
    await fixture(layout, async (root, cliPath) => {
      const native = await helper(cliPath);
      const before = Object.getOwnPropertyDescriptors(native);
      const pipe = `\\\\.\\pipe\\cotal-peer-trace-${randomUUID()}`;
      const output = join(root, "receipts.jsonl"), lock = join(root, "daemon.lock");
      const listener = native.pipeListen(pipe);
      let originalPromise, originalPeer, calls = 0, stop, peer, accepted;
      native.pipeConnect = new Proxy(before.pipeConnect.value, { apply(target, receiver, args) {
        calls++;
        originalPromise = Reflect.apply(target, receiver, args);
        originalPromise.then(value => { originalPeer = value; }, () => {});
        return originalPromise;
      } });
      try {
        stop = await installWindowsPeerTraceFromContext({ cliPath, pipe, lock, output });
        assert.equal(typeof stop, "function");
        accepted = native.pipeAccept(listener);
        accepted.catch(() => {});
        const { connectPipe } = await import(pathToFileURL(join(dirname(findPackageJSON("@cotal-ai/seat", pathToFileURL(cliPath))), "dist/host.js")).href);
        const promise = connectPipe(pipe, 5000);
        assert.equal(promise, originalPromise);
        peer = await promise;
        assert.equal(peer, originalPeer);
        assert.equal(calls, 1, "observer never opens another pipe");
        assert.equal(peer.pid, process.pid);
        fs.fstatSync(peer.fd); // The observer left the actual descriptor open and owned by its caller.
        const connected = receipts(output).find(r => r.phase === "pipe-connected");
        assert.deepEqual(connected.peer, { pid: peer.pid, birth: peer.birth });
        assert.equal(JSON.stringify(connected).includes(peer.user), false, "no user SID retained");
      } finally {
        stop?.();
        native.pipeConnect = before.pipeConnect.value;
        native.pipeClose(listener);
        if (peer) fs.closeSync(peer.fd);
        if (accepted) { const remote = await accepted.catch(() => undefined); if (remote?.fd !== undefined) fs.closeSync(remote.fd); }
      }
      assert.deepEqual(Object.getOwnPropertyDescriptors(native), before);
    });
  });

  test(`${layout} real Windows stock endpoint refusal retains one native connect and one client lock read`, { skip: missingBundle || process.platform !== "win32", timeout: 15000 }, async () => {
    await fixture(layout, async (root, cliPath) => {
      const native = await helper(cliPath), before = Object.getOwnPropertyDescriptors(native);
      const pipe = `\\\\.\\pipe\\cotal-peer-trace-${randomUUID()}`;
      const lock = join(root, "daemon.lock"), output = join(root, "receipts.jsonl");
      const raw = JSON.stringify({ v: 1, pid: process.pid, start: "deliberately-not-the-server-birth", startedAt: new Date().toISOString() }) + "\r\n";
      fs.writeFileSync(lock, raw, { mode: 0o600 });
      const listener = native.pipeListen(pipe);
      const read = fs.readFileSync;
      let calls = 0, reads = 0, accepted, stop;
      native.pipeConnect = new Proxy(before.pipeConnect.value, { apply(target, receiver, args) { calls++; return Reflect.apply(target, receiver, args); } });
      fs.readFileSync = function (...args) { if (args[0] === lock) reads++; return Reflect.apply(read, this, args); };
      syncBuiltinESMExports();
      try {
        stop = await installWindowsPeerTraceFromContext({ cliPath, pipe, lock, output });
        assert.equal(typeof stop, "function");
        const { queryDaemon } = await import(pathToFileURL(join(dirname(cliPath), "daemon/client.js")).href);
        accepted = native.pipeAccept(listener);
        accepted.catch(() => {});
        const counters = { bytesWritten: 0 };
        await assert.rejects(queryDaemon({ paths: { socket: pipe, lock, state: root }, counters }), error => {
          assert.equal(error.code, "PEER_NOT_LOCK_OWNER");
          assert.equal(error.message, `the process answering at ${pipe} is not the daemon holding ${lock}; nothing was sent`);
          return true;
        });
        // Exercise the exact stdout frame emitted by a refused CLI without changing the client.
        await new Promise(resolve => process.stdout.write('{"error":{"code":"PEER_NOT_LOCK_OWNER"}}\n', resolve));
        assert.equal(calls, 1);
        assert.equal(reads, 1);
        assert.equal(counters.bytesWritten, 0);
        const found = receipts(output);
        assert.deepEqual(found.map(r => r.phase), ["peer-trace-installed", "pipe-connected", "lock-read", "client-refusal"]);
        assert.equal(found[1].peer.pid, process.pid);
        assert.equal(found[2].bytesBase64, Buffer.from(raw).toString("base64"));
        assert.equal(found[3].afterAttempt, found[1].attempt);
        assert.equal(found[3].afterRead, found[2].read);
      } finally {
        stop?.();
        native.pipeConnect = before.pipeConnect.value;
        fs.readFileSync = read;
        syncBuiltinESMExports();
        native.pipeClose(listener);
        if (accepted) { const remote = await accepted.catch(() => undefined); if (remote?.fd !== undefined) fs.closeSync(remote.fd); }
      }
      assert.deepEqual(Object.getOwnPropertyDescriptors(native), before);
    });
  });
}

test("ordinary child stdout retains refusal receipt after earlier test reports", async () => {
  const found = [], before = Object.getOwnPropertyDescriptor(process.stdout, "write");
  const stop = installWindowsPeerTrace({ native: { pipeConnect() {} }, pipePath: "fixture-pipe", lockPath: "fixture-lock", record: r => found.push(r) });
  try {
    // In a --test worker this allows earlier binary reports into the pending line,
    // reproducing the run27 missing receipt even when the host has no Windows pipes.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => process.stdout.write('{"error":{"code":"PEER_NOT_LOCK_OWNER"}}\n', resolve));
    assert.deepEqual(found.map(r => r.phase), ["client-refusal"]);
  } finally { stop(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(process.stdout, "write"), before);
});

test("context resolution failure receipt retains only a safe code and stage", async () => {
  const root = fs.mkdtempSync(join(fixtureRoot, "missing-"));
  try {
    const output = join(root, "receipts.jsonl");
    assert.equal(await installWindowsPeerTraceFromContext({ cliPath: join(root, "missing/cotal.js"), pipe: "fixture-pipe", lock: join(root, "daemon.lock"), output }), undefined);
    const [receipt] = receipts(output);
    assert.equal(receipt.phase, "peer-trace-install-failed");
    assert.equal(receipt.stage, "resolve-package");
    assert.equal(receipt.errorCode, "ERR_MODULE_NOT_FOUND");
    assert.equal(JSON.stringify(receipt).includes(root), false);
    assert.deepEqual(Object.keys(receipt).sort(), ["at", "errorCode", "phase", "pid", "stage"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
}
