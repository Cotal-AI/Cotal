import assert from "node:assert/strict";
import { spawn } from "node:child_process";

let interrupted;

// The publisher and its install gate run on the POSIX Actions runner. Own the whole child group,
// and observe close before removing scratch files or declaring an admitted operation settled.
export function runPublicationChild(file, args, { cwd, env, timeout, capture = false }) {
  assert(process.platform !== "win32", "publication checks require POSIX process-group custody");
  assert(Number.isFinite(timeout) && timeout >= 1, "publication subprocess needs a finite positive timeout");
  if (interrupted) throw Object.assign(new Error("publication was interrupted; no new subprocess is admitted"), { code: "ERR_PUBLICATION_INTERRUPTED" });
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    const stdout = [], stderr = [];
    let error, bytes = 0, terminated = false;
    const stop = (failure) => {
      if (terminated) return;
      terminated = true; error = failure;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (failure) { if (failure.code !== "ESRCH") error = failure; }
    };
    const onExit = () => stop(new Error("publication owner exited"));
    const onSignal = () => { interrupted = true; stop(Object.assign(new Error("publication was interrupted"), { code: "ERR_PUBLICATION_INTERRUPTED" })); };
    process.once("exit", onExit); process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    const timer = setTimeout(() => stop(Object.assign(new Error("publication subprocess exceeded its deadline"), { code: "ETIMEDOUT" })), timeout);
    if (capture) for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("error", stop);
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) stop(Object.assign(new Error("publication subprocess exceeded its output limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
        else chunks.push(chunk);
      });
    }
    child.once("error", (failure) => { error = failure; });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      process.removeListener("exit", onExit); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
      resolve({ status, signal, error, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
