import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import type { IPty } from "@lydell/node-pty";
import { observeWindowsProcess, windowsUserSid } from "./host.js";

const requireHere = createRequire(import.meta.url);
const disposablePtyVersion = "1.2.0-beta.12";

/** Windows node-pty publishes its child PID asynchronously after connecting the console data pipe.
 * A zero PID is not a child identity. Register this alongside the host's exit/output listeners,
 * before writing a running record or acknowledging the launch. */
export async function observeConPtyChild(pty: Pick<IPty, "pid" | "onExit">, session: number, timeoutMs: number): Promise<{ pid: number; start: string }> {
  const deadline = performance.now() + timeoutMs, own = windowsUserSid();
  let exited = false;
  const subscription = pty.onExit(() => { exited = true; });
  try {
    while (!exited && performance.now() < deadline) {
      const pid = pty.pid;
      if (pid > 0) {
        const live = observeWindowsProcess(pid);
        if (!live || live.user !== own || live.session !== session) break;
        return { pid, start: live.birth };
      }
      await delay(20);
    }
    throw new Error("Windows PTY child identity is unavailable");
  } finally { subscription.dispose(); }
}

/** Fail before launch if the pinned DLL-mode dependency seam cannot be used. */
export function assertWindowsConPtyDisposal(): void {
  if (process.platform !== "win32") throw new Error("Windows PTY disposal requires Windows");
  const manifest = join(dirname(requireHere.resolve("@lydell/node-pty")), "package.json");
  const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
  if (name !== "@lydell/node-pty" || version !== disposablePtyVersion) throw new Error("unsupported Windows PTY disposal version");
}

/** Bind the exact child and its I/O at readiness. Dispose only after its exit event and kernel proof.
 * Neither node-pty's kill nor its destroy method is safe for this: both can terminate processes. */
export function windowsConPtyDisposal(terminal: IPty, identity: { pid: number; start: string }, session: number): () => Promise<boolean> {
  assertWindowsConPtyDisposal();
  const { pid, start } = identity;
  const live = observeWindowsProcess(pid);
  if (terminal.pid !== pid || !live || live.birth !== start || live.session !== session || live.user !== windowsUserSid())
    throw new Error("Windows PTY disposal identity does not match the live child");
  const agent = (terminal as IPty & { _agent?: PinnedWindowsPtyAgent })._agent;
  const input = agent?._inSocket, worker = agent?._conoutSocketWorker?._worker;
  if (agent?._useConptyDll !== true || typeof input?.destroy !== "function" || typeof worker?.terminate !== "function")
    throw new Error("Windows PTY disposal seam is unavailable");
  let exited = false;
  const exit = terminal.onExit(() => { exited = true; });
  let released: Promise<boolean> | undefined;
  return async () => {
    if (released) return released;
    if (!exited || observeWindowsProcess(pid)?.birth === start) return false;
    exit.dispose();
    released = disposeConPtyIo(input, worker);
    return released;
  };
}

interface PinnedWindowsPtyAgent {
  _useConptyDll?: boolean;
  _inSocket?: Socket;
  _conoutSocketWorker?: { _worker?: Worker };
}

async function disposeConPtyIo(input: Socket, worker: Worker): Promise<boolean> {
  const closed = input.closed ? Promise.resolve() : new Promise<void>(resolve => input.once("close", resolve));
  input.destroy();
  await Promise.all([closed, worker.terminate()]);
  return true;
}
