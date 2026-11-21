import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { UpdateRuntime } from "../commands/update.js";

/** Wait outside the closure lock: an orphan may still need it to finish reconciliation. */
export function continueAfterGlobalUpdateChild(rt: UpdateRuntime): string | undefined {
  const prefix = rt.executionGlobalRoot ? undefined : rt.installPrefix();
  const root = rt.executionGlobalRoot?.() ?? (prefix && join(prefix, "lib", "node_modules"));
  if (!root || !lstatSync(join(root, ".cotal-update-child"), { throwIfNoEntry: false })) return;
  rt.out("Waiting for the recorded global update child to finish.");
  const release = rt.claimGlobalUpdate(root);
  try {
    const version = rt.globalVersion?.(root);
    if (!version) throw new Error("cannot verify the installed CLI after waiting for the global update child");
    return (rt.verifyUpdatedEntry ?? rt.verifyGlobalEntry)(root, version);
  } finally { release(); }
}
