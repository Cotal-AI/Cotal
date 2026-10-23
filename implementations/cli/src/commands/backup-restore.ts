import { resolve } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import { brokerAddressForDisplay, CommandFailure, isCommandFailure, presentationOf, writeResult, type Report } from "@cotal-ai/workspace";
import { cotalRoot } from "../lib/paths.js";
import { heldRestoreAttempt } from "../lib/restore.js";
import { assertStoreDirArgument } from "../lib/store-dir.js";
import { startRestore, type RestoreStartupResult } from "./up.js";

/** `backup restore <dir>`: the guarded native restore through `up --restore`'s own authority. It
 *  restores only into the stopped preserved cut this root recorded, through the same maintenance
 *  lock, claim, trust and space proofs, and resumes the retained stack from it. A controller cut
 *  restores through its own recorded members and broker definition (`prepareRestore`). */
export async function backupRestore(args: ParsedArgs): Promise<void> {
  const values = args.values as { only?: string; "store-dir"?: string; "accept-missing-source"?: boolean; json?: boolean; plain?: boolean };
  const directory = resolve(args.positionals[1]!);
  const target = { directory };
  if (values["store-dir"] !== undefined) assertStoreDirArgument(values["store-dir"], cotalRoot());
  let result: RestoreStartupResult;
  try {
    result = await startRestore({
      restore: directory,
      ...(values.only === "registry" ? { "restore-only": "registry" } : {}),
      ...(values["accept-missing-source"] === true ? { "accept-missing-source": true } : {}),
      ...(values["store-dir"] !== undefined ? { "store-dir": values["store-dir"] } : {}),
    });
  } catch (error) {
    if (isCommandFailure(error)) throw error;
    const message = (error as Error).message;
    // Every other native restore guard throws a plain error. Its message is the operator's evidence,
    // kept verbatim; whether the attempt advanced is the journal's to say, so it is read and named.
    const root = cotalRoot();
    const held = heldRestoreAttempt(root);
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", message, {
      target: { ...target, root, ...(held ? { attemptId: held.attemptId, journalState: held.journalState } : {}) },
      remedy: held?.remedy ?? "this root's maintenance journal names no restore attempt; check it with cotal status before another restore",
    });
  }
  // The native activation throws on a degraded control plane or auth service before this point, so
  // a returned result is a healthy one. A static or open mesh has no auth service to report.
  const data = {
    kind: "backup-restore" as const,
    attemptId: result.attemptId,
    space: result.space,
    root: result.root,
    server: brokerAddressForDisplay(result.server) ?? "not displayable",
    mode: result.mode,
    selection: result.selection,
    store: result.targetPath,
    runtime: result.runtime,
    brokerPid: result.brokerPid,
    delivery: result.delivery,
    authService: result.mode === "user" ? result.authService : null,
    manager: result.manager,
    controlPlane: result.controlPlane,
    journalState: "active" as const,
    // The native finalize evidence names only the attempt, its active state and the commit token, so
    // there is no per-seat outcome to report: a full restore hands retained seats to the manager's
    // resume, and a registry restore drops them from the inventory (restore.ts, staleConsent).
    seatResume: result.selection === "full" ? "requested" as const : "not-requested" as const,
  };
  writeResult(presentationOf(values), {
    command: "backup restore",
    target: { directory, space: result.space, root: result.root, attemptId: result.attemptId },
    result: data,
    // The restore itself succeeded (outcome ok); what it does not observe is completeness, as for
    // `team boot`. `partial` here would make a successful restore exit 4.
    completeness: data.seatResume === "requested" ? "partial" : "complete",
    warnings: data.seatResume === "requested" ? [{ code: "AGENT_READINESS_NOT_CHECKED", target: { space: result.space }, message: "Retained seats were offered to the manager's resume; whether each one joined is not checked." }] : [],
  }, (row): Report => ({ sections: [
    { title: "Backup restored", blocks: [
      { kind: "fields", rows: [["Space", row.space], ["Root", row.root], ["Restore attempt", row.attemptId], ["Selection", row.selection], ["Store", row.store], ["Broker", row.server], ["Broker PID", String(row.brokerPid)], ["Manager", row.manager ? "started" : "not started"], ["Delivery", row.delivery ? "started" : "not started"], ["Seat resume", row.seatResume], ["Journal", "active"]] },
      ...(row.seatResume === "requested" ? [] : [{ kind: "lines" as const, lines: ["A registry-only restore resumes no seat."] }]),
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [
      { command: `cotal status --space ${row.space}`, description: "Check the restored stack" },
      { command: `cotal backup cleanup-fallback ${row.attemptId}`, description: "Retire the restore journal and any unchanged retained old store, after review" },
    ] }] },
  ] }));
}
