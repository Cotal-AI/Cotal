import { spawnSync } from "node:child_process";
import { CommandFailure, win32ProcessBinding, type Win32ProcessPin } from "@cotal-ai/workspace";
import { queryDaemon } from "./client.js";
import { EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { readLifetimeRecord } from "./lifetime.js";
import { readReceipt } from "./install-receipt.js";
import { scheduledTaskService } from "./install-win32.js";
import { checkWindowsRecordedUnit } from "./ownership-win32.js";
import { recordedSourceIdentity } from "./install-identity.js";
import { daemonArgv } from "@cotal-ai/cli";
import type { NativeRun } from "./install.js";

let captured: { paths: DaemonPaths; pin: Win32ProcessPin; receipt: string } | undefined;

/** Retain the authenticated old generation before reconciliation can make it exit. */
export async function captureWindowsGeneration(paths: DaemonPaths): Promise<void> {
  if (process.platform !== "win32" || captured) return;
  const receipt = readReceipt(paths);
  if (!receipt) return;
  try {
    const reply = await queryDaemon({ paths });
    if (!reply.ok) throw new Error("the Windows daemon refused its initial generation observation");
    const before = readLifetimeRecord(paths.lock);
    if (!before?.start || before.pid !== reply.result.pid) throw new Error("the Windows daemon lifetime changed before capture");
    const pin = win32ProcessBinding().pinProcess(before.pid);
    try {
      const after = readLifetimeRecord(paths.lock);
      if (pin.token !== before.start || pin.exited() || after?.pid !== before.pid || after.start !== before.start)
        throw new Error("the Windows daemon lifetime changed during capture");
      captured = { paths, pin, receipt: JSON.stringify(receipt) };
    } finally { if (captured?.pin !== pin) pin.close(); }
  } catch (error) {
    if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") return;
    throw error;
  }
}

/** Release an old-generation observation on every update outcome. */
export function closeWindowsGeneration(): void {
  captured?.pin.close(); captured = undefined;
}

/** Native supervision after a published Windows daemon exits successfully needs an explicit Run. */
export async function windowsGenerationLifecycle(paths: DaemonPaths, deadline: number): Promise<{ poll(remainingMs: number): Promise<void>; close(): void }> {
  if (process.platform !== "win32" || !captured || captured.paths.lock !== paths.lock)
    throw new Error("the Windows update has no retained authenticated daemon lifetime");
  const retained = captured;
  let started = false;
  const run: NativeRun = (file, args, env) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Windows generation startup exceeded the update readiness deadline");
    const result = spawnSync(file, args, { env, encoding: "utf8", timeout: Math.min(30_000, remaining), maxBuffer: 256 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.signal) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "Windows generation inspection could not complete within the update readiness deadline");
    return { status: result.status, stdout: result.stdout, detail: result.stderr.trim().slice(0, 300) };
  };
  const task = scheduledTaskService(run);
  return {
    async poll() {
      if (started || !retained.pin.exited()) return;
      const receipt = readReceipt(paths);
      if (!receipt || JSON.stringify(receipt) !== retained.receipt) throw new Error("the Windows daemon installation changed during update");
      checkWindowsRecordedUnit(paths, receipt, task);
      if (!recordedSourceIdentity(receipt, "scheduled-task", [...daemonArgv(), "daemon", "serve"]).same)
        throw new Error("the Windows daemon source names another installation");
      const native = task.inspect(receipt);
      if (!native.present || native.enabled !== true) throw new Error("the Windows daemon task is absent or disabled; update did not enable it");
      if (native.instances !== 0) { started = true; return; }
      // startEnabled performs its own fresh source/principal/action/enabled/instance check.
      task.startEnabled(receipt);
      started = true;
    },
    close: closeWindowsGeneration,
  };
}
