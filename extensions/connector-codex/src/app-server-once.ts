/**
 * One request to a short-lived `codex app-server` over stdio, the read behind the model catalog and
 * the skill list a launcher reads before any seat exists.
 */
import { spawn } from "node:child_process";

export interface AppServerAsk {
  bin: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  method: string;
  params: unknown;
  boundMs: number;
}

/** The `result` of `method`, sent after `initialize`. Rejects when the server answers an error, exits
 *  first, or does not answer within `boundMs`. The server and what it started, such as the `git` it
 *  runs to sync plugins, are killed on return. */
export async function askAppServer(o: AppServerAsk): Promise<unknown> {
  // Its own process group, so the kill below reaches the children it started too.
  const child = spawn(o.bin, ["app-server"], { env: o.env, cwd: o.cwd, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`codex app-server ${o.method} timed out (${o.boundMs / 1000}s)`)), o.boundMs);
      let buf = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 1) {
            child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: o.method, params: o.params }) + "\n");
          } else if (msg.id === 2) {
            clearTimeout(timer);
            if (msg.error) reject(new Error(msg.error.message ?? `${o.method} failed`));
            else resolve(msg.result);
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      // `close`, not `exit`: `exit` can fire while stdout still holds the response of a child that
      // answers and exits at once. `close` follows the end of stdout, after every `data` event has
      // been handled, so that response is read first.
      child.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`codex app-server exited (${code}) before ${o.method} answered`));
      });
      // A write to a pipe the child already closed fails on stdin, which the ChildProcess does not
      // forward; without this listener that `error` is uncaught and takes the manager down.
      child.stdin!.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`codex app-server stdin failed before ${o.method} answered (${e.message})`));
      });
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "cotal", title: "Cotal", version: "0.0.0" } } }) + "\n",
      );
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    });
  } finally {
    kill(child.pid);
  }
}

function kill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
