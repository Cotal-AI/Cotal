import type { ChildProcess } from "node:child_process";

/** Stop one exact owned child. Returns only after its exit was observed. */
export async function stopOwnedChild(child: ChildProcess, opts: {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
} = {}): Promise<"term" | "kill"> {
  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
    });

  child.kill("SIGTERM");
  if (await waitForExit(opts.termTimeoutMs ?? 3_000)) return "term";
  child.kill("SIGKILL");
  if (await waitForExit(opts.killTimeoutMs ?? 3_000)) return "kill";
  throw new Error(`owned child ${child.pid ?? "unknown"} did not exit after SIGTERM then SIGKILL; refusing to remove its state or release the cleanup backstop`);
}
