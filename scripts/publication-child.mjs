import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

let interrupted;

// A live supervisor keeps ownership of the process group until the client has exited.
// Do not confuse its close, or the client's exit, with settlement of the whole group.
export function runPublicationChild(file, args, { cwd, env, timeout, capture = false }) {
  assert(process.platform !== "win32", "publication checks require POSIX process-group custody");
  assert(Number.isFinite(timeout) && timeout >= 1, "publication subprocess needs a finite positive timeout");
  if (interrupted) throw Object.assign(new Error("publication was interrupted; no new subprocess is admitted"), { code: "ERR_PUBLICATION_INTERRUPTED" });
  const began = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./publication-child-supervisor.mjs", import.meta.url))], {
      cwd, env, detached: true, stdio: capture ? ["ignore", "pipe", "pipe", "ipc"] : ["inherit", "inherit", "inherit", "ipc"],
    });
    const stdout = [], stderr = [];
    let error, bytes = 0, stopped = false, result;
    const stop = (failure) => {
      error ??= failure;
      if (stopped || !child.pid) return;
      stopped = true;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (failure) { if (failure.code !== "ESRCH") error ??= failure; }
    };
    const onExit = () => stop(new Error("publication owner exited"));
    const onSignal = () => { interrupted = true; stop(Object.assign(new Error("publication was interrupted"), { code: "ERR_PUBLICATION_INTERRUPTED" })); };
    process.once("exit", onExit); process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    const timer = setTimeout(() => stop(Object.assign(new Error("publication subprocess exceeded its deadline"), { code: "ETIMEDOUT" })), Math.max(1, timeout - (performance.now() - began)));
    if (capture) for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("error", stop);
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) stop(Object.assign(new Error("publication subprocess exceeded its output limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
        else chunks.push(chunk);
      });
    }
    child.once("spawn", () => child.send({ file, args }, (failure) => { if (failure) stop(failure); }));
    child.once("error", (failure) => { error ??= failure; });
    child.on("message", (message) => {
      if (result || message?.type !== "result" || message.pid !== child.pid || !(message.status === null || Number.isInteger(message.status)) || !(message.signal === null || typeof message.signal === "string")) {
        stop(new Error("publication supervisor returned an invalid result"));
        return;
      }
      result = message;
      if (message.error) error ??= Object.assign(new Error(message.error.message), { code: message.error.code });
      stop();
    });
    child.once("close", async (status, signal) => {
      if (!stopped && child.pid) stop(new Error("publication supervisor exited without settling its client"));
      // Observation after SIGKILL is bounded and admits no new work. A surviving or unreadable
      // group is not permission to remove its scratch files, even after the original deadline.
      const until = performance.now() + 2_000;
      let settled = !child.pid;
      while (!settled) {
        try { process.kill(-child.pid, 0); }
        catch (failure) {
          if (failure.code === "ESRCH") { settled = true; break; }
          error ??= failure; break;
        }
        if (performance.now() >= until) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      if (!settled) {
        interrupted = true;
        error = Object.assign(new Error(`publication process group ${child.pid} has not been observed settled`), { code: "ERR_PUBLICATION_UNSETTLED", pgid: child.pid });
      }
      clearTimeout(timer);
      process.removeListener("exit", onExit); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
      resolve({ status: result ? result.status : status, signal: result ? result.signal : signal, error, settled, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
