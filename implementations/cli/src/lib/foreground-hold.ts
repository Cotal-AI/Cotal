/** The process record a foreground `up` writes while it holds a controller stack's lifetime. The
 *  holding process removes its own record as it exits. A whole-stack stop removes one whose process
 *  is gone, such as a holder that was killed, and leaves one that still runs or cannot be read. */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { assertRecordIdentity, codeSpan, exitCode, findMesh, formatRecord, identityRecord, parseRecord, renderReport, shellPath } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";
import { displayCmd } from "./self-exec.js";
import { observeServiceProcess, serviceInstanceStore } from "./service-instances.js";
import { readStackJournal, stackDefinitionsAt, stackRootGone, type StackJournal } from "./stack-journal.js";

/** Where a foreground `up` records the process that holds its stack's lifetime. */
const foregroundHoldPath = (root: string): string => join(root, ".cotal", "stack-foreground.hold");

/** The process of another foreground `up` that holds `root`'s stack, while that exact process runs. */
export function foregroundHolder(root: string): number | undefined {
  let raw: string;
  try { raw = readFileSync(foregroundHoldPath(root), "utf8"); } catch { return undefined; }
  const read = parseRecord(raw);
  if (read.kind !== "record" || read.record.pid === process.pid) return undefined;
  return assertRecordIdentity(read.record).kind === "match" ? read.record.pid : undefined;
}

/** Record this process as the foreground holder of `root`'s stack. A host that cannot pin a process
 *  start records nothing, so no later `up` refuses on a pid that may have been reused. */
export function claimForegroundHold(root: string): void {
  const record = identityRecord(process.pid);
  if ("token" in record) writeSecretFileAtomic(foregroundHoldPath(root), `${formatRecord(record)}\n`);
}

/** Remove this process's foreground hold record, and leave one another process wrote. */
export function releaseForegroundHold(root: string): void {
  try {
    const read = parseRecord(readFileSync(foregroundHoldPath(root), "utf8"));
    if (read.kind === "record" && read.record.pid === process.pid) unlinkSync(foregroundHoldPath(root));
  } catch { /* nothing recorded */ }
}

/** A hangup leaves the stack running. Release the hold before exiting without unwinding finally. */
export function hangupForegroundStack(root: string, space: string): never {
  const gone = stackRootGone(space, root);
  const stop = `${displayCmd({ fromAnyFolder: gone })} down`;
  const remedy = gone
    ? `run ${codeSpan(`${stop} --space ${shellWord(space)} --yes`)} from another folder to stop it`
    : `${codeSpan(`cd ${shellWord(root)} && ${stop}`)} stops it`;
  process.stderr.write(`The terminal closed. This stack is still running; ${remedy}.\n`);
  process.exitCode = 129;
  releaseForegroundHold(root);
  process.exit(129);
}

/** Remove a foreground hold whose recorded process is gone, and leave one that still runs or cannot
 *  be read. A whole-stack stop calls this: the holding process removes its own record as it exits,
 *  and a holder that was killed does not. */
export function releaseDeadForegroundHold(root: string): boolean {
  const path = foregroundHoldPath(root);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return false; }
  const read = parseRecord(raw);
  if (read.kind !== "record" || assertRecordIdentity(read.record).kind !== "gone") return false;
  try { unlinkSync(path); } catch { return false; }
  return true;
}

function foregroundReleased(message: string): 0 {
  process.stderr.write(`${renderReport({ sections: [{ title: "Foreground stack released", blocks: [{ kind: "lines", lines: [message] }] }] }, "rich", process.stderr)}\n`);
  return 0;
}

/** The missing-folder stop observes the pinned exits, then removes definitions and registration. */
function goneRootStackStopped(held: StackJournal): boolean {
  const members = held.members.filter((member) => member.instanceId !== null);
  return members.length > 0 && members.every((member) => {
    const state = member.process && assertRecordIdentity(member.process).kind;
    return state === "gone" || state === "mismatch";
  }) && stackDefinitionsAt(held.space, held.root).length === 0 && findMesh(held.space)?.root !== held.root;
}

/** Read-only lifetime check. An unreadable record is not proof that its process exited. */
export function foregroundStackEnd(root: string, held: StackJournal | undefined): number | undefined {
  const journal = () => { try { return readStackJournal(root)?.journal; } catch { return undefined; } };
  let current: StackJournal | undefined;
  try {
    current = readStackJournal(root)?.journal;
    if (!current) return held && goneRootStackStopped(held)
      ? foregroundReleased("Another command stopped this stack and removed its saved records after its folder went missing. This terminal no longer holds it.") : undefined;
  } catch { return; }
  const { operation, space } = current;
  if (operation.id !== held?.operation.id && (operation.kind === "down" || operation.kind === "preserve")) {
    if (operation.phase === "completed") {
      return foregroundReleased(`Another command completed a ${operation.kind === "down" ? "stop" : "preserve"} of this stack (operation ${operation.id}). This terminal no longer holds it.`);
    }
    if (operation.phase === "planned" || operation.phase === "applying") return;
  }
  const broker = current.members.find((member) => member.role === "broker");
  if (!broker?.instanceId) return;
  let pid: number;
  try {
    const instance = serviceInstanceStore(space).read(broker.instanceId)?.record.value;
    if (!instance?.process || instance.definition !== broker.definition) return;
    const state = observeServiceProcess(instance);
    if (state !== "gone" && state !== "foreign-pid") return;
    pid = instance.process.pid;
  } catch { return; }
  // A whole-stack stop or replacement can begin between reading the journal and observing the PID.
  const latest = journal()?.operation;
  if (latest?.id !== operation.id || latest.phase !== operation.phase) return;
  const brokerOnly = current.members.some((member) => member.role === "manager" && member.state === "not-attempted" && member.code === undefined);
  process.stderr.write(`nats-server exited unexpectedly (pid ${pid}). The stack records were kept. Run \`${displayCmd()} up --foreground${brokerOnly ? " --no-manager" : ""} --root ${shellPath(root)}\` to repair the stack.\n`);
  return exitCode("failed", "OPERATION_FAILED");
}
