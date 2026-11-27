import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { IPty } from "@lydell/node-pty";
import { observeWindowsProcess, windowsUserSid } from "./host.js";

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
