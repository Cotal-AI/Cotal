import { renderReport } from "@cotal-ai/workspace";
import type { UpdateRuntime } from "../commands/update.js";
import { compareSemver } from "../seed/reconcile.js";

export function reportVersion(current: string, latest: string, rt: UpdateRuntime, reconciled: boolean): void {
  const available = compareSemver(latest, current) > 0;
  rt.out(renderReport({ sections: [
    { title: "CLI version", blocks: [{ kind: "fields", rows: [["This process", current], ["Registry latest", latest], ["Update", available ? { text: "available", tone: "waiting" } : "no newer latest tag"]] }, { kind: "lines", lines: [{ text: "Running processes keep the generation they loaded. This version report does not prove every live service was upgraded.", tone: "hint" }] }] },
    ...(reconciled ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: available ? "cotal update --self" : "cotal status", description: !available ? "Inspect the machine and selected space" : rt.checkout() ? "Install the validated CLI as a separate global copy and reconcile through it; this checkout does not change" : "Install the validated CLI and reconcile its matching extensions" }] }] }] : []),
  ] }, "rich", process.stdout));
}
