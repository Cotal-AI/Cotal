/** Explicit signal stop when a stack's launching home has lost all exact instance records.
 * The root journal must retain its launch-time home, host and member creation pins. */
import { resolve } from "node:path";
import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, ConfirmationRequired, assertRecordIdentity, homeCotalDir, isCommandFailure, isMeshRegistryError, loadMeshes, localProcessOwnerStatus, presentationOf, probeLiveness, readMaintenanceLockHolder, recordOperationSpace, releaseMaintenanceLock, stackHomeRemedy, writeResult, type Report } from "@cotal-ai/workspace";
import { serviceInstances, serviceInstanceStore } from "../lib/service-instances.js";
import { assertNoServiceUnitAttempts } from "../lib/service-process.js";
import { acquireStackOperationLock, knownStackRecoveryHost, newStackOperation, readStackJournal, recordedProcessesUnder, stackMaintenanceFence, stackOperationUnsettled, stackRecoveryHost, withSettledMembers, writeStackJournal, type StackJournal, type StackMember } from "../lib/stack-journal.js";
import { displayCmd, displayRemedy } from "../lib/self-exec.js";

const ORDER = ["manager", "delivery", "auth", "broker"];
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const recoveryStop = "run `cotal down --dry-run` to inspect its pinned members, then `cotal down --yes`";

function unconfirmedLaunches(journal: StackJournal): StackMember[] {
  if (journal.operation.kind !== "up" || !stackOperationUnsettled(journal)) return [];
  return journal.members.filter((row) => row.instanceId === null && (row.state === "planned" || row.state === "unknown"));
}

function missingRecord(row: StackMember, store: ReturnType<typeof serviceInstanceStore>): boolean {
  return row.instanceId !== null && store.read(row.instanceId) === undefined;
}

/** Missing launch evidence also includes a child whose instance ID never reached the root journal. */
export function stackRecordsLost(journal: StackJournal): boolean {
  const space = journal.space, store = serviceInstanceStore(space);
  return journal.members.some((row) => missingRecord(row, store))
    || (unconfirmedLaunches(journal).length > 0 && journal.members.every((row) => serviceInstances(space, row.definition).length === 0));
}

/** A replacement with its own matching instance record can be adopted by the ordinary stop. */
export function recordedReplacementSupersedesLostRecords(journal: StackJournal): boolean {
  const pending = journal.members.filter((row) => row.replacement !== undefined && row.instanceId !== null);
  if (pending.length === 0) return false;
  let adopted: StackJournal;
  try { adopted = withSettledMembers(journal, undefined); }
  catch (error) { if (isCommandFailure(error)) return false; throw error; }
  const store = serviceInstanceStore(journal.space);
  for (const row of pending) {
    const next = adopted.members.find((member) => member.role === row.role);
    if (!next || next.instanceId === null || next.instanceId === row.instanceId || missingRecord(next, store)) return false;
  }
  return !stackRecordsLost(adopted);
}

/** Observe a broker from its journal when this home cannot supply its instance record. */
export function lostBrokerRecord(journal: StackJournal): { space: string; pid: number | null; message: string; hint: string; otherHome?: string } | undefined {
  const launch = journal.recovery;
  if (process.platform !== "linux" || !launch || launch.host !== knownStackRecoveryHost()) return undefined;
  const broker = journal.members.find((row) => row.role === "broker");
  if (broker === undefined) return undefined;
  const pin = broker.process;
  const pid = broker.replacement === undefined && pin !== undefined && assertRecordIdentity(pin).kind === "match" ? pin.pid : null;
  if (pid === null && broker.replacement === undefined) return undefined;
  if (launch.home !== resolve(homeCotalDir())) {
    const message = pid === null
      ? `the stack for "${journal.space}" retains an unresolved broker replacement and was launched under a different Cotal home`
      : `the broker for "${journal.space}" is still running, but the stack was launched under a different Cotal home`;
    return { space: journal.space, pid, message, otherHome: launch.home, hint: stackHomeRemedy(launch.home) };
  }
  if (!missingRecord(broker, serviceInstanceStore(journal.space))) return undefined;
  const replacement = journal.members.some((row) => row.replacement !== undefined);
  if (replacement && recordedReplacementSupersedesLostRecords(journal)) return undefined;
  const missing = "the stack's member records are missing from this Cotal home";
  const message = replacement
    ? `${missing}; the journal retains an unresolved replacement launch, so ownership of the replacement is unconfirmed`
    : `the broker for "${journal.space}" is still running, but ${missing}`;
  return { space: journal.space, pid, message, hint: missingRecordsStopHint(journal) };
}

/** Use the stop's read-only preflight to distinguish a preview from a records repair. */
function missingRecordsStopHint(journal: StackJournal): string {
  try { members(journal); }
  catch (error) {
    if (isMeshRegistryError(error)) return "repair the unreadable mesh registry before attempting the recovery stop";
    if (!isCommandFailure(error)) throw error;
    return `restore the original stack member records in ${journal.root} before stopping or starting the stack`;
  }
  return `from ${journal.root}, ${displayRemedy(recoveryStop, displayCmd())}`;
}

function members(journal: StackJournal): StackMember[] {
  const target = { root: journal.root, space: journal.space };
  const refuse = (message: string): never => { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", message, { target, remedy: stackHomeRemedy(journal.recovery?.home) }); };
  if (process.platform !== "linux") refuse("recovery from missing stack instance records requires Linux; no member was stopped");
  if (!journal.recovery || journal.recovery.home !== resolve(homeCotalDir()) || journal.recovery.host !== stackRecoveryHost())
    refuse("the stack's member records are missing here, and its journal does not pin this launching home, machine, boot and account; no member was stopped");
  if (stackMaintenanceFence(journal.root, journal).fenced || !["up", "down"].includes(journal.operation.kind))
    refuse("the stack retains a maintenance operation; missing-record recovery cannot decide it and no member was stopped");
  if (journal.members.some((row) => row.replacement !== undefined))
    refuse("the stack retains an unresolved replacement launch; no member was stopped");
  if (unconfirmedLaunches(journal).length) {
    const holder = readMaintenanceLockHolder(journal.root);
    if (holder?.operation === "foreground up" && localProcessOwnerStatus(holder.owner) === "alive")
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "a foreground startup is still in progress; no member was stopped", { target, remedy: "wait for startup to finish, then retry `cotal down --yes`" });
    refuse("the stack retains an unconfirmed launch without an instance identity; restore the original instance records before stopping, and no member was stopped");
  }
  const rows = journal.members.filter((row) => row.instanceId !== null);
  const store = serviceInstanceStore(journal.space);
  if (rows.some((row) => store.read(row.instanceId!) !== undefined))
    refuse("only some stack instance records are missing; restore the complete records before stopping, and no member was stopped");
  if (serviceInstances(journal.space).length)
    refuse("other service instance records remain in this space; restore the complete records before stopping, and no member was stopped");
  for (const row of rows) assertNoServiceUnitAttempts(journal.space, row.definition);
  if (rows.some((row) => row.process === undefined))
    refuse("the stack journal lacks a complete set of member creation pins; no member was stopped");
  if (loadMeshes().some((row) => row.space !== journal.space && row.server === journal.server))
    refuse("another registered space uses this broker address; missing-record recovery stopped nothing");
  const pids = new Set(rows.map((row) => row.process!.pid));
  if (recordedProcessesUnder(journal.root, [journal.space]).some((row) => row.pid === undefined || !pids.has(row.pid)))
    refuse("another or unreadable process record remains under this root; missing-record recovery stopped nothing");
  for (const row of rows) {
    const verdict = assertRecordIdentity(row.process!);
    if (!["match", "gone", "mismatch"].includes(verdict.kind))
      refuse(`the ${row.role} creation identity cannot be checked; no member was stopped`);
  }
  return rows.sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
}

/** Recovery never recreates service authority or runs a native adapter with inferred records. */
export async function lostRecordsStackDown(root: string, values: ParsedArgs["values"]): Promise<void> {
  if (["with-agents", "abandon-stop", "abandon-launch", "preserve-state"].some((flag) => values[flag] !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "missing-record recovery takes only --space, --yes, --dry-run and presentation flags; no member was stopped");
  const presentation = presentationOf(values);
  const inspect = () => {
    const snapshot = readStackJournal(root);
    if (!snapshot) throw new CommandFailure("refused", "CONFLICT", "the stack journal disappeared before recovery; nothing was inferred");
    if (values.space !== undefined && values.space !== snapshot.journal.space)
      throw new CommandFailure("refused", "CONFLICT", "--space is not this folder's stack; no member was stopped");
    if (!stackRecordsLost(snapshot.journal)) throw new CommandFailure("refused", "CONFLICT", "the stack instance records changed before recovery; run down again");
    return { snapshot, rows: members(snapshot.journal) };
  };
  const initial = inspect();
  recordOperationSpace(initial.snapshot.journal.space);
  const target = { root, space: initial.snapshot.journal.space };
  const preview = initial.rows.map((row) => ({ role: row.role, instanceId: row.instanceId, pid: row.process!.pid, process: assertRecordIdentity(row.process!).kind === "match" ? "running" : "gone" }));
  if (values["dry-run"] === true) {
    writeResult(presentation, { command: "down", target, result: { kind: "missing-records-stack-stop-preview", members: preview, dryRun: true, signalled: false }, noOp: true }, (): Report => ({ sections: [{ title: "Stack member records are missing", blocks: [
      { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "instanceId", label: "Full instance" }, { key: "pid", label: "Pid" }, { key: "process", label: "Process" }], rows: preview.map((row) => ({ ...row, instanceId: row.instanceId!, pid: String(row.pid) })) },
      { kind: "lines", lines: ["Nothing was stopped or written. down --yes sends SIGTERM to the journal's creation-pinned members, manager first and broker last. It does not restore the missing service records."] },
    ] }] }));
    return;
  }
  const journal = initial.snapshot.journal;
  if (journal.operation.kind === "down" && journal.operation.phase === "completed" && initial.rows.every((row) =>
    (row.state === "stopped" || row.state === "already-stopped") && ["gone", "mismatch"].includes(assertRecordIdentity(row.process!).kind))) {
    writeResult(presentation, { command: "down", target, result: { kind: "missing-records-stack-stop", members: journal.members, recordsRestored: false }, noOp: true }, () => ({ sections: [{ title: "Stack is already stopped", blocks: [{ kind: "lines", lines: ["Every creation-pinned member is gone. No signal was sent or record changed."] }] }] }));
    return;
  }
  if (values.yes !== true) throw new ConfirmationRequired("stopping a stack whose instance records are missing requires --yes", { target, remedy: recoveryStop });
  const lock = acquireStackOperationLock(root, "down");
  try {
    let { snapshot, rows } = inspect();
    const operation = newStackOperation("down");
    const save = (phase: "applying" | "completed" | "unknown", member?: StackMember) => {
      snapshot = writeStackJournal(root, snapshot, { ...snapshot.journal, members: snapshot.journal.members.map((row) => row.role === member?.role ? member : row), operation: { ...operation, phase }, updatedAt: new Date().toISOString() });
    };
    save("applying");
    for (const row of rows) {
      // Never continue under records or broker-sharing scope that reappeared during an earlier stop.
      const current = readStackJournal(root);
      if (!current || current.sha256 !== snapshot.sha256) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the stack journal changed during recovery; later members were not stopped", { target });
      try { members(current.journal); }
      catch {
        save("unknown");
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the recovery scope changed after the stop began; recorded member outcomes were kept and later members were not stopped", { target, remedy: "restore the missing records or inspect the stack journal before running down again" });
      }
      const pin = row.process!, verdict = assertRecordIdentity(pin);
      if (verdict.kind === "match") {
        try { process.kill(pin.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { save("unknown"); throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the ${row.role} signal was not confirmed; later members were not stopped`, { target }); } }
        const deadline = Date.now() + (row.role === "manager" ? 90_000 : 30_000);
        while (assertRecordIdentity(pin).kind === "match" && probeLiveness(pin.pid) !== "dead" && Date.now() < deadline) await delay(100);
        const after = assertRecordIdentity(pin);
        if (after.kind !== "gone" && after.kind !== "mismatch") {
          save("unknown");
          throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the ${row.role} exit was not confirmed; later members were not stopped`, { target, remedy: "run `cotal down --yes` again once that member exits" });
        }
      } else if (verdict.kind !== "gone" && verdict.kind !== "mismatch") {
        save("unknown");
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the ${row.role} identity could not be verified; it and later members were not stopped`, { target });
      }
      save("applying", { ...row, state: verdict.kind === "match" ? "stopped" : "already-stopped" });
    }
    save("completed");
    writeResult(presentation, { command: "down", target, result: { kind: "missing-records-stack-stop", members: snapshot.journal.members, recordsRestored: false } }, () => ({ sections: [{ title: "Stack stopped from its journal pins", blocks: [{ kind: "lines", lines: ["Every recorded member exited. Missing home records were not recreated. Prepare this space again with space create before starting it."] }] }, { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal space create ${target.space}`, description: "Prepare the space again here, then run `cotal up`" }] }] }] }));
  } finally { releaseMaintenanceLock(lock); }
}
