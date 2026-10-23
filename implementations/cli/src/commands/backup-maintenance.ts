import * as prompts from "../lib/prompts.js";
import type { ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, acquireMaintenanceLock, assertSingleSpaceBroker, assessRestoreClaim, authDir,
  cleanupRestoreFallback, isCommandFailure, isMaintenanceError, oneLine, presentationOf,
  readMaintenanceJournal, releaseMaintenanceLock, writeResult, type Report,
} from "@cotal-ai/workspace";
import { rollbackRestoreWithBroker } from "../lib/controller-restore.js";
import { heldRestoreClaim, restoreNextStep } from "../lib/restore.js";
import { attemptProcessesGone } from "../lib/isolated-broker.js";
import { acquireStackOperationLock } from "../lib/stack-journal.js";
import { cotalRoot } from "../lib/paths.js";
import { canPrompt } from "./meshes-wizard.js";

type RecoveryRecord = NonNullable<ReturnType<typeof readMaintenanceJournal>> & { state: "restore-ready" | "active" };

/** The original journal and full attempt are the target, never the source artifact or active selection. */
export async function backupMaintenance(args: ParsedArgs): Promise<void> {
  const [mode, attemptId] = args.positionals as ["recover" | "cleanup-fallback", string];
  const root = cotalRoot(), presentation = presentationOf(args.values);
  let recorded: ReturnType<typeof readMaintenanceJournal>;
  try { assertSingleSpaceBroker(authDir(root), `cotal backup ${mode}`); recorded = readMaintenanceJournal(root); }
  catch (error) { throw new CommandFailure("refused", isMaintenanceError(error) && error.code === "journal-missing" ? "TARGET_NOT_FOUND" : "LIFECYCLE_BLOCKED", "the local root has no safely readable single-space maintenance record; no recovery or cleanup was attempted", { target: { root, attemptId } }); }
  if (!recorded || !("restore" in recorded) || recorded.restore.attemptId !== attemptId) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no maintenance record at this root names that full restore attempt; no source manifest or prefix was used", { target: { root, attemptId }, remedy: recorded && "restore" in recorded ? `this root holds restore attempt ${recorded.restore.attemptId} (state ${recorded.state}); ${restoreNextStep(recorded.state, recorded.restore.attemptId)}` : mode === "cleanup-fallback" ? "this root holds no restore attempt; a completed cleanup-fallback retires its journal, so a repeated cleanup finds nothing to do" : "this root holds no restore attempt; cotal status shows its maintenance state" });
  if (mode === "recover" && recorded.state !== "restore-ready") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "pre-commit recovery requires restore-ready; a committed, active or degraded restore must recover forward instead of rolling back", { target: { root, space: recorded.space, attemptId, state: recorded.state }, remedy: restoreNextStep(recorded.state, attemptId) });
  if (mode === "cleanup-fallback" && recorded.state !== "active") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "fallback cleanup requires the matching healthy active restore; no stopped or degraded state was promoted", { target: { root, space: recorded.space, attemptId, state: recorded.state }, remedy: restoreNextStep(recorded.state, attemptId) });
  const snapshot = recorded as RecoveryRecord;
  const target = { root, space: snapshot.space, attemptId, revision: snapshot.revision };
  const restore = snapshot.restore;
  const assessment = snapshot.state === "restore-ready" ? assessRestoreClaim(snapshot, { unrecordedOwnersDead: attemptProcessesGone(root) }) : null;
  const claim = snapshot.state === "restore-ready" ? snapshot.claim : undefined;
  const preview = { kind: "backup-maintenance-preview", operation: mode, ...target, state: snapshot.state, preservedSource: snapshot.source.path, restoreTarget: restore.targetPath, previousSource: restore.previousSource?.identity.path ?? null, restoreMethod: restore.method, claimAssessment: assessment, claimDeadline: claim?.deadline ?? null, claimHolderPid: claim?.coordinator.pid ?? null, effectAttempted: false, nativeGuardsStillRequired: true };
  if (args.values["dry-run"]) {
    writeResult(presentation, { command: `backup ${mode}`, target, result: preview }, (data): Report => ({ sections: [{ title: "Maintenance operation plan", blocks: [
      { kind: "fields", rows: [["Operation", data.operation], ["Root", data.root], ["Space", data.space], ["Full restore attempt", data.attemptId], ["Journal revision", String(data.revision)], ["Recorded state", data.state], ["Preserved source", data.preservedSource], ["Restore target", data.restoreTarget], ["Previous source", data.previousSource ?? (data.restoreMethod === "disaster" ? "none retained; the restore replaced a missing source" : "not recorded")], ["Claim observation", data.claimAssessment ?? "not a pre-commit claim"], ...(data.claimDeadline ? [["Claim deadline", data.claimDeadline], ["Restore process", String(data.claimHolderPid)]] as [string, string][] : [])] },
      { kind: "lines", lines: [mode === "recover" ? "Apply requires the restore process and every recorded watchdog and broker proven dead, and either every broker this root started proven gone or the claim deadline passed. It uses native rollback; a live or ambiguous owner refuses. No coordinator override or process kill is supplied." : data.restoreMethod === "disaster" ? "Apply retires the completed restore journal after the native healthy-active and finalization checks. This restore retained no old store, so nothing is removed, and the active restored target is never deleted." : "Apply removes only the matching unchanged old-store identity after the native healthy-active and finalization checks. It never deletes the active restored target and retires the completed restore journal only after cleanup.", "Preview took no maintenance lock and made no filesystem change. Store identity, liveness and journal revision must pass again at apply; this is not permission to delete a path by hand."] },
    ] }] }));
    return;
  }
  if (!args.values.yes) {
    if (!canPrompt() || presentation === "json") throw new CommandFailure("refused", "USAGE_INVALID", "scripted maintenance recovery/cleanup requires --yes after reviewing the exact attempt and paths", { target, remedy: `review it with cotal backup ${mode} ${attemptId} --dry-run, then run cotal backup ${mode} ${attemptId} --yes` });
    const confirmed = await prompts.confirm({ message: `${mode === "recover" ? "Recover the stale pre-commit attempt" : restore.method === "disaster" ? "Retire the completed restore journal for" : "Remove only the unchanged retained old source for"} ${oneLine(attemptId)} in ${oneLine(snapshot.space)}? Root ${oneLine(root)}; source ${oneLine(mode === "recover" ? snapshot.source.path : restore.previousSource?.identity.path ?? "not recorded")}. No live-owner, identity or journal guard is bypassed.`, initialValue: false });
    if (prompts.isCancel(confirmed) || !confirmed) {
      writeResult(presentation, { command: `backup ${mode}`, target, result: { kind: "backup-maintenance-cancelled", operation: mode, changed: false }, noOp: true }, () => ({ sections: [{ title: "Maintenance state kept", blocks: [{ kind: "lines", lines: ["No recovery, cleanup or process signal was requested."] }] }] }));
      return;
    }
  }
  let lock: ReturnType<typeof acquireMaintenanceLock> | undefined;
  let invoked = false;
  let result: { kind: string; operation: string; root: string; space: string; attemptId: string; state: string; preservedSource: string; activeTarget: string | null; restoreMethod: string; originalRevision: number; processSignals: false } | undefined;
  let failure: CommandFailure | undefined;
  let fatal: unknown;
  try {
    lock = acquireStackOperationLock(root);
    assertSingleSpaceBroker(authDir(root), `cotal backup ${mode}`);
    const current = readMaintenanceJournal(root);
    if (!current || current.revision !== snapshot.revision || current.state !== snapshot.state || !("restore" in current) || current.restore.attemptId !== attemptId) throw new CommandFailure("refused", "CONFLICT", "the reviewed maintenance journal changed; no recovery or cleanup was submitted", { target });
    if (mode === "recover") {
      if (current.state !== "restore-ready") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "pre-commit recovery requires restore-ready; no rollback was submitted", { target, remedy: restoreNextStep(current.state, attemptId) });
      const unrecordedOwnersDead = attemptProcessesGone(root);
      const held = assessRestoreClaim(current, { unrecordedOwnersDead });
      if (held !== "stale") throw heldRestoreClaim(root, current, "cotal backup recover", held);
      invoked = true;
      const ready = rollbackRestoreWithBroker(lock, { unrecordedOwnersDead });
      result = { kind: "backup-attempt-recovered", operation: mode, root, space: ready.space, attemptId, state: ready.state, preservedSource: ready.source.path, activeTarget: null, restoreMethod: restore.method, originalRevision: snapshot.revision, processSignals: false };
    } else {
      invoked = true;
      const active = cleanupRestoreFallback(lock, attemptId);
      result = { kind: "backup-fallback-cleaned", operation: mode, root, space: active.space, attemptId, state: "completed-restore-journal-retired", preservedSource: active.source.path, activeTarget: active.restore.target.path, restoreMethod: active.restore.method, originalRevision: snapshot.revision, processSignals: false };
    }
  } catch (error) {
    fatal = isCommandFailure(error) ? error : new CommandFailure(invoked ? "unknown" : "refused", invoked ? "OPERATION_UNKNOWN" : "LIFECYCLE_BLOCKED", invoked ? "the native maintenance operation did not confirm completion; the original attempt was not retried" : "the native maintenance preflight or lock refused before operation submission", { target, ...(isMaintenanceError(error) ? { native: { code: error.code } } : {}), remedy: "re-read the original maintenance attempt and retain both source and target until its native recovery state is established" });
  } finally {
    if (lock) {
      try { releaseMaintenanceLock(lock); }
      catch {
        if (result) failure = new CommandFailure("partial", "OPERATION_PARTIAL", "the native operation returned its result, but maintenance-lock cleanup was not confirmed", { target, changed: [result] });
        else if (!fatal) fatal = new CommandFailure("unknown", "OPERATION_UNKNOWN", "maintenance-lock cleanup is unconfirmed; no operation was retried", { target });
      }
    }
  }
  if (fatal) throw fatal;
  writeResult(presentation, { command: `backup ${mode}`, target, result: result!, failure }, (data): Report => ({ sections: [{ title: mode === "recover" ? "Stale restore attempt recovered" : data.restoreMethod === "disaster" ? "Completed restore journal retired" : "Retained old source cleaned", blocks: [
    { kind: "fields", rows: [["Root", data.root], ["Space", data.space], ["Full restore attempt", data.attemptId], ["State", data.state], ["Preserved source", data.preservedSource], ["Active target", data.activeTarget ?? "not activated by this operation"], ["Process signals", "none"]] },
    { kind: "lines", lines: [{ text: mode === "recover" ? "The native stale-attempt rollback returned the source to its ready state. No live coordinator override, broker start or restore retry was performed. Resuming the space remains a separate guarded operation." : data.restoreMethod === "disaster" ? "This restore replaced a missing source and retained no old store, so nothing was removed. The completed restore journal was retired after the native finalization checks, so a later down --preserve-state can start a new backup cycle. The restored target was not deleted." : "Native cleanup completed for the recorded old-source identity and retired the completed restore journal. The restored target was not deleted. No broad reset, identity rotation or live process signal was performed.", tone: "hint" }] },
  ] }] }));
}
