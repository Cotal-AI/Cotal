import { readPreparedSpaces, preparedRecordSkipped, preparedRecordSpace, recordOperationWarning, recordUpdateCompletion, renderReport, type UnreadableConnectorSelection } from "@cotal-ai/workspace";
import type { UpdateRuntime } from "../commands/update.js";
import { compareSemver } from "../seed/reconcile.js";
import { c } from "../ui.js";

export function reportCurrentUpdate(current: string, latest: string, rt: UpdateRuntime, target: Record<string, unknown>, unreadableSelection?: UnreadableConnectorSelection): boolean {
  if (unreadableSelection) {
    rt.err(unreadableSelection.message);
    rt.out("No newer CLI version. No connector reconciliation was run.");
  } else {
    if (!rt.isCurrent?.()) return false;
    reportUncheckedPreparedRecords(rt, target);
    rt.out("No newer CLI version; installed package closure is current. No connector reconciliation was run.");
    if (rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateCompletion(current, "up to date", true);
  }
  reportVersion(current, latest, rt, false);
  return true;
}

export function reportUncheckedPreparedRecords(rt: UpdateRuntime, target: Record<string, unknown>): void {
  if (["server", "creds", "on"].some(key => typeof target[key] === "string")) return;
  // The installed child may carry a daemon admission receipt and never resolve the project.
  // Report read failures separately from the Manager custody verdict and package reconciliation.
  try {
    for (const error of readPreparedSpaces().unusable) {
      if (error.refusal !== "PERMISSION_DENIED") continue;
      if (typeof target.space === "string" && target.space !== preparedRecordSpace(error.file)) continue;
      recordOperationWarning(preparedRecordSkipped(error));
      rt.out(c.dim(`  ${error.file}: leaving its records and processes untouched, continuity not checked`));
    }
  } catch (error) {
    rt.err(`Could not check prepared space records: ${error instanceof Error ? error.message : String(error)}; continuity not checked`);
  }
}

export function reportVersion(current: string, latest: string, rt: UpdateRuntime, reconciled: boolean): void {
  const available = compareSemver(latest, current) > 0;
  rt.out(renderReport({ sections: [
    { title: "CLI version", blocks: [{ kind: "fields", rows: [["This process", current], ["Registry latest", latest], ["Update", available ? { text: "available", tone: "waiting" } : "no newer latest tag"]] }, { kind: "lines", lines: [{ text: "Running processes keep the generation they loaded. This version report does not prove every live service was upgraded.", tone: "hint" }] }] },
    ...(reconciled ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: available ? "cotal update --self" : "cotal status", description: !available ? "Inspect the machine and selected space" : rt.checkout() ? "Install the validated CLI as a separate global copy and reconcile through it; this checkout does not change" : "Install the validated CLI and reconcile its matching extensions" }] }] }] : []),
  ] }, "rich", process.stdout));
}
