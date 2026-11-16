import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace/local-observation";
import { scheduledTaskService } from "./install-win32.js";
import { nativeRun } from "./install-native-run.js";
import { recordedSourceIdentity, recordedSourceMarked } from "./install-identity.js";
import { readReceipt, unitReceiptFile } from "./install-receipt.js";
import type { DaemonPaths } from "./endpoint.js";
import type { DaemonOwnershipObservation, NativeService, UnitReceipt } from "./install.js";

/** The Windows receipt and registered job checks shared by installer and observer. */
export function checkWindowsRecordedUnit(paths: Pick<DaemonPaths, "state">, receipt: UnitReceipt, service: NativeService): void {
  const mechanism = receipt.mechanism ?? "systemd-user";
  if (mechanism !== "scheduled-task") throw new CommandFailure("refused", "CONFLICT", `the recorded unit ${receipt.unit} is a ${mechanism} unit, which this OS does not run; nothing was removed`);
  try { lstatSync(receipt.unitPath); }
  catch { throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the recorded unit file ${receipt.unitPath} is gone; nothing was removed. Delete ${unitReceiptFile(paths)} by hand to forget it`); }
  if (receipt.unitPath !== join(paths.state, "service-task.xml")) throw new CommandFailure("refused", "CONFLICT", "the scheduled-task receipt names a definition outside this daemon state; nothing was changed");
  service.check(receipt);
}

/** Fresh Windows provenance through the installer's exact receipt, source, task and identity checks. */
export function observeWindowsOwnedService(paths: Pick<DaemonPaths, "state">, expected: readonly string[]): DaemonOwnershipObservation {
  if (process.env.COTAL_DAEMON_NATIVE_SERVICE !== "1") return { state: "not-owned", reason: "marker-absent" };
  try {
    const receipt = readReceipt(paths);
    if (!receipt) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "this daemon has no installed unit recorded by `cotal daemon install`; nothing was removed");
    checkWindowsRecordedUnit(paths, receipt, scheduledTaskService(nativeRun));
    if (!recordedSourceIdentity(receipt, "scheduled-task", expected).same) return { state: "not-owned", reason: "identity-differs" };
    const marked = recordedSourceMarked(receipt, "scheduled-task");
    return marked ? { state: "owned", reason: "verified" } : { state: "not-owned", reason: "source-marker-absent" };
  } catch { return { state: "unknown", reason: "observation-failed" }; }
}
