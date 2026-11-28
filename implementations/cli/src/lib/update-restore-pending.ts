import { readUpdateRecovery, scheduleWaitingRestore, waitingRestore, writeUpdateRecovery } from "@cotal-ai/workspace";

export class RestoreAdmissionPending extends Error {}

/** Keep the journal and snapshot after the previous installation has been verified. */
export function keepRestorePending(error: unknown, version: string): boolean {
  if (!(error instanceof RestoreAdmissionPending)) return false;
  const recovery = readUpdateRecovery();
  if (recovery?.phase !== "restoring" || recovery.previous !== version) return false;
  writeUpdateRecovery({ ...recovery, installed: version, preparedRestart: false, reason: waitingRestore });
  scheduleWaitingRestore(recovery.target);
  return true;
}
