import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { capturePeerProcess, recoverProcess, processStartToken, type LinuxProcessHandle } from "@cotal-ai/seat";
import { loadNativeHelper } from "../src/peercred.js";

if (process.argv[2] === "client") {
  const socket = createConnection(process.argv[3]!);
  const timer = setTimeout(() => process.exit(2), 15_000);
  socket.on("error", () => process.exit(3));
  process.once("message", () => { clearTimeout(timer); socket.end(); process.disconnect?.(); });
} else {
  let checks = 0;
  const check = (label: string, value: unknown) => { assert.ok(value, label); checks++; console.log(`  ✓ ${label}`); };
  const bounded = async <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("process fixture deadline")), 10_000); })]); }
    finally { clearTimeout(timer); }
  };
  if (process.platform !== "linux") {
    assert.throws(() => recoverProcess({} as never), /unsupported/);
    check("unsupported platform refuses custody", true);
  } else {
    const root = mkdtempSync(join(tmpdir(), "process-handles-"));
    const server = createServer();
    let child: ChildProcess | undefined, socket: Socket | undefined, worker: Worker | undefined;
    const handles: LinuxProcessHandle[] = [];
    try {
      const path = join(root, "p.sock");
      server.listen(path);
      await bounded(once(server, "listening"));
      const connected = once(server, "connection");
      child = fork(fileURLToPath(import.meta.url), ["client", path], { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const childExit = once(child, "exit");
      [socket] = await bounded(connected) as [Socket];
      const original = capturePeerProcess(socket); handles.push(original);
      console.log(JSON.stringify({ receipt: "owned-processes", owner: { pid: process.pid, birth: processStartToken(process.pid) }, child: original.identity }));
      check("kernel peer is the real live child", original.identity.pid === child.pid && !original.hasExited());
      check("identity is frozen and owned", Object.isFrozen(original.identity) && original.identity.uid === process.getuid!());
      const recovered = recoverProcess(original.identity); handles.push(recovered);
      check("recovery matches every recorded field", JSON.stringify(original.identity) === JSON.stringify(recovered.identity));
      for (const [key, value] of [["birth", "0"], ["boot", "other-boot"], ["namespace", "pid:[0]"], ["uid", -1], ["pid", 1.5]] as const) {
        assert.throws(() => recoverProcess({ ...original.identity, [key]: value }));
        check(`invalid ${key} refuses without stopping the child`, !original.hasExited());
      }
      const native = loadNativeHelper<{ hasProcessExited(h: unknown): boolean; closeProcess(h: unknown): void; openProcessCandidate(pid: number): unknown; cancelProcessWait(w: unknown): void }>();
      for (const value of [{}, null, 3, { fd: 0 }, original]) {
        assert.throws(() => native.hasProcessExited(value));
        check("native rejects unbranded process token", true);
      }
      assert.throws(() => native.openProcessCandidate(1.5)); check("native does not truncate fractional PID", true);
      assert.throws(() => native.cancelProcessWait({})); check("native rejects unbranded wait token", true);
      const pre = AbortSignal.abort(new Error("already cancelled"));
      await assert.rejects(original.waitForExit({ signal: pre }), /already cancelled/);
      check("already-aborted wait refuses", !original.hasExited());
      const abort = new AbortController();
      const cancelled = assert.rejects(original.waitForExit({ signal: abort.signal }), /cancelled wait/);
      abort.abort(new Error("cancelled wait")); await cancelled;
      check("abort preserves live capability", !original.hasExited());
      const closing = recoverProcess(original.identity); handles.push(closing);
      const closedWait = assert.rejects(closing.waitForExit(), /handle is closed/);
      closing.close(); await bounded(closedWait);
      assert.throws(() => closing.hasExited(), /closed/);
      assert.throws(() => closing.signal("SIGKILL"), /closed/);
      closing.close(); check("close rejects pending wait and is not process exit", !original.hasExited());
      const asyncContext = new AsyncLocalStorage<string>();
      let observed: string | undefined;
      const waits = asyncContext.run("owned-context", () => Array.from({ length: 64 }, () => original.waitForExit().then(() => { observed = asyncContext.getStore(); })));
      const workerCode = `const {parentPort,workerData}=require('node:worker_threads'); import(workerData.module).then(({recoverProcess})=>{const h=recoverProcess(workerData.identity);h.waitForExit();parentPort.postMessage('waiting');});`;
      worker = new Worker(workerCode, { eval: true, workerData: { module: new URL("../dist/process.js", import.meta.url).href, identity: original.identity } });
      check("worker started a real pending wait", (await bounded(once(worker, "message")))[0] === "waiting");
      await bounded(worker.terminate()); worker = undefined;
      check("worker teardown preserves the foreign-to-worker child", !original.hasExited());
      const fdBefore = readdirSync("/proc/self/fd").length;
      for (let i = 0; i < 32; i++) {
        const h = recoverProcess(original.identity);
        const a = new AbortController();
        const wait = h.waitForExit({ signal: a.signal }).catch(() => undefined);
        a.abort(); await wait; h.close();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      check("cancelled waits release duplicated descriptors", readdirSync("/proc/self/fd").length <= fdBefore);
      child.send("finish");
      await bounded(Promise.all(waits));
      check("64 concurrent kernel waits observed real child exit", original.hasExited() && recovered.hasExited());
      check("exit observation retains async context", observed === "owned-context");
      const [code, signal] = await bounded(childExit);
      check("finished child exited normally", code === 0 && signal === null);
      await original.waitForExit(); check("already-exited handle resolves", true);
      assert.throws(() => recoverProcess(original.identity)); check("completed predecessor refuses recovery", true);
      assert.throws(() => original.signal("SIGKILL")); check("exited predecessor refuses signal", true);
      socket.destroy();
      const secondConnection = once(server, "connection");
      child = fork(fileURLToPath(import.meta.url), ["client", path], { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const secondExit = once(child, "exit");
      [socket] = await bounded(secondConnection) as [Socket];
      const signalled = capturePeerProcess(socket); handles.push(signalled);
      console.log(JSON.stringify({ receipt: "signal-process", child: signalled.identity }));
      assert.throws(() => signalled.signal("not-a-signal" as NodeJS.Signals));
      check("unknown signal refuses without a side effect", !signalled.hasExited());
      const signalledExit = signalled.waitForExit();
      signalled.signal("SIGTERM");
      await bounded(signalledExit);
      const [signalledCode, signalledSignal] = await bounded(secondExit);
      check("pidfd delivers the requested signal to the captured child", signalledCode === null && signalledSignal === "SIGTERM");
      check("kernel wait observes signalled process exit", signalled.hasExited());
      check("native check count is complete", checks === 30);

    } finally {
      if (worker) await worker.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit"); child.kill("SIGKILL"); await bounded(exit);
      }
      for (const handle of handles) handle.close();
      socket?.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`PROCESS HANDLES (${checks} checks)`);
}
