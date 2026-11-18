import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectorSetupInput } from "@cotal-ai/core";
import { processGroupMembers } from "@cotal-ai/workspace";

type Run = NonNullable<ConnectorSetupInput["machineHost"]>["run"];
export type SetupCommand = { file: string; args: readonly string[] } & Parameters<Run>[2];

export class SetupExitUnconfirmed extends Error {}

/** Stop timed out or cancelled commands before returning, including ordinary child processes of
 * a native command or a Windows shim. Never turn a successful signal call into an exit receipt. */
export async function runMachineSetupCommand(
  file: Parameters<Run>[0], args: Parameters<Run>[1], opts: Parameters<Run>[2], signal: AbortSignal,
): ReturnType<Run> {
  signal.throwIfAborted();
  if (process.platform === "win32") return runWindows({ file, args, ...opts }, signal);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error(`native setup custody is unsupported on ${process.platform}`);
  const child = spawn(file, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = child.pid;
  let stopError: unknown;
  let failure: string | undefined;
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    failure ??= reason;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") stopError = error;
    }
  };
  const onAbort = () => stop("Claude wake setup cancelled because the Manager is stopping");
  const timer = setTimeout(() => stop(`native setup command timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
  signal.addEventListener("abort", onAbort, { once: true });
  const collect = (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > opts.maxBuffer) stop("native setup command exceeded its output limit");
      else if (!failure) chunks.push(chunk);
    });
    return chunks;
  };
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  try {
    const status = await new Promise<number | null>((resolve) => {
      child.on("error", error => { failure ??= error.message; });
      child.once("close", resolve);
      if (signal.aborted) onAbort();
    });
    try { while (stopError === undefined && pid !== undefined && processGroupMembers(pid).length > 0) await delay(20); }
    catch (error) { stopError = error; }
    if (stopError !== undefined) throw new SetupExitUnconfirmed("native setup process cleanup could not be verified", { cause: stopError });
    signal.throwIfAborted();
    return failure ? { status: null, output: failure } : { status, output: `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`.trim() };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** The native binding holds one job per process. The helper returns a receipt only after it drains
 * the job. Closing its IPC requests cancellation while leaving it alive to confirm the drain. */
async function runWindows(input: SetupCommand, signal: AbortSignal): ReturnType<Run> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./machine-setup-windows.js", import.meta.url))], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, serialization: "advanced",
  });
  let result: Awaited<ReturnType<Run>> | undefined;
  let error: Error | undefined;
  const cancel = () => { if (child.connected) child.disconnect(); };
  const sendFailed = (cause?: Error | null) => { if (cause) { error = cause; cancel(); } };
  // Send abort without closing the channel: the helper must be able to acknowledge a drained job.
  const abort = () => { if (child.connected) child.send?.({ cancel: true }, sendFailed); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve) => {
      child.on("error", (cause) => { error = cause; });
      child.on("message", (message) => { result = message as typeof result; });
      child.once("close", () => resolve());
      child.send!(input, sendFailed);
      if (signal.aborted) abort();
    });
    if (child.pid === undefined) throw error ?? new Error("native setup job could not start");
    if (!result) throw new SetupExitUnconfirmed("native setup job did not confirm exit", { cause: error });
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
