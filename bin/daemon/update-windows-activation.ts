import { join } from "node:path";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { homeCotalDir, readUpdateRecovery, win32ProcessBinding } from "@cotal-ai/workspace";
import { queryDaemon } from "./client.js";
import { daemonPaths } from "./endpoint.js";
import { readLifetimeRecord } from "./lifetime.js";
import { readReceipt } from "./install-receipt.js";
import { installedDaemonIdentity, restartInstalled } from "./install.js";
import { scheduledTaskService } from "./install-win32.js";
import { nativeRun } from "./install-native-run.js";
import { checkWindowsRecordedUnit } from "./ownership-win32.js";
import { installedGenerationVersion } from "./generation.js";

export const WINDOWS_ACTIVATION_TIMEOUT_MS = 240_000;

/** Retain this helper's authenticated old daemon before its worker replaces the package. */
export async function captureWindowsAutomaticActivation(nonce: string): Promise<{ activate(): Promise<void>; close(): void }> {
  if (process.platform !== "win32") throw new Error("automatic Windows activation requires Windows");
  const paths = daemonPaths();
  const receipt = readReceipt(paths);
  if (!receipt || !installedDaemonIdentity(paths).same) throw new Error("automatic activation does not own this daemon installation");
  const task = scheduledTaskService(nativeRun);
  checkWindowsRecordedUnit(paths, receipt, task);
  const native = task.inspect(receipt);
  if (!native.present || native.enabled !== true || native.instances !== 1) throw new Error("automatic activation requires one enabled owned daemon task instance");
  const reply = await queryDaemon({ paths });
  if (!reply.ok) throw new Error("the owned daemon refused activation capture");
  const old = readLifetimeRecord(paths.lock);
  if (!old?.start || old.pid !== reply.result.pid) throw new Error("the owned daemon lifetime changed before activation capture");
  const pin = win32ProcessBinding().pinProcess(old.pid);
  try {
    const after = readLifetimeRecord(paths.lock);
    if (pin.token !== old.start || pin.exited() || after?.pid !== old.pid || after.start !== old.start || JSON.stringify(readReceipt(paths)) !== JSON.stringify(receipt)) throw new Error("the owned daemon changed during activation capture");
  } catch (error) { pin.close(); throw error; }
  const capturedReceipt = JSON.stringify(receipt);
  return {
    async activate() {
      const startedAt = Date.now(), deadline = startedAt + WINDOWS_ACTIVATION_TIMEOUT_MS;
      let target = reply.result.version;
      const result = { v: 1, nonce, install: "verified", source: reply.result.version, target, old: { pid: old.pid, start: old.start }, startedAt, deadline, timeoutMs: WINDOWS_ACTIVATION_TIMEOUT_MS };
      const save = (activation: "pending" | "ready" | "failed" | "not-needed", detail?: string) => writeSecretFileAtomic(join(homeCotalDir(), "update-windows-activation.json"), `${JSON.stringify({ ...result, activation, observedAt: Date.now(), ...(detail ? { detail } : {}) })}\n`);
      save("pending");
      try {
        target = installedGenerationVersion(); result.target = target;
        if (readUpdateRecovery()) throw new Error("the installed release still has an unresolved update recovery record");
        if (target === reply.result.version) { save("not-needed", "installed generation unchanged"); return; }
        await restartInstalled(paths, undefined, false, target, line => process.stderr.write(`automatic activation: ${line}\n`), { deadline, receipt: capturedReceipt, pid: old.pid, start: old.start!, exited: () => pin.exited() });
        if (Date.now() > deadline) throw new Error("Windows automatic activation deadline expired");
        save("ready");
      } catch (error) {
        save("failed", `${error instanceof Error ? error.message : String(error)}; release remains installed; use Start service`);
        throw error;
      }
    },
    close: () => pin.close(),
  };
}
