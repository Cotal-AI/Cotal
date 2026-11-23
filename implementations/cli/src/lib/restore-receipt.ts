import { canonicalRoot, readMaintenanceJournal, restoreLeftOut } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { leftOutNotes, restoreComposition, restoreHistory, restoreNextStep, type PreparedRestore } from "./restore.js";
import { displayCmd } from "./self-exec.js";

/** The human receipt for a completed `up --restore`. `backup restore` prints its own receipt. */
export function printRestoreReceipt(restored: PreparedRestore, invokedRoot?: string): void {
  console.log(c.green(`✓ restored the backup ${restored.selection === "registry" ? "registry" : "in full"} as restore attempt ${restored.attemptId}`));
  const composition = restoreComposition(restored.space, restored.restoredStreams, restored.mode);
  console.log(c.dim(`restored: ${composition.restoredWords}; recreated empty: ${composition.emptyWords}`));
  if (composition.note) console.log(c.yellow(composition.note));
  const cleanupRoot = invokedRoot && invokedRoot !== canonicalRoot(restored.root) ? restored.root : undefined;
  const cmd = displayCmd();
  const { onlyCopy, emptyNote } = restoreHistory(restored.root, restored.attemptId);
  if (emptyNote) console.log(c.dim(emptyNote));
  for (const line of leftOutNotes(restored.attemptId, restored.selection, onlyCopy, cleanupRoot, cmd)) console.log(c.yellow(line));
  const journal = readMaintenanceJournal(restored.root);
  if (journal && "restore" in journal && journal.restore.attemptId === restored.attemptId)
    console.log(c.dim(`next: ${restoreNextStep(journal.state, restored.attemptId, restoreLeftOut(journal), cleanupRoot, cmd)}`));
}
