/** The root-local whole-stack journal: which controller definitions and full instances one local
 *  stack owns, and the last whole-stack operation's per-member outcome. One owner-private file at
 *  `<root>/.cotal/stack-controller.json`. It is not a service record, unit receipt or team ledger,
 *  and it grants no stop authority by itself: every effect still rechecks the instance records. */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { acquireLock, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, admittedControllerRestore, canonicalRoot, decodeLocalJson, loadMeshes, localProcessPath, localProcessPathCandidates, localRecordObject, parsePid, probeLiveness, readLocalRecordSource, readMaintenanceJournal, readPidfile, recordedLocalProcessPaths, serviceOperationId, type ControllerStackView, stackJournalPath } from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { observeServiceProcess, serviceInstances } from "./service-instances.js";

export const STACK_ROLES = ["broker", "auth", "delivery", "manager"] as const;
export type StackRole = (typeof STACK_ROLES)[number];

/** The fixed, root-bound definition names a controller stack owns. A custom definition with
 *  another name is never swept into the stack, whatever its adapter. */
export const STACK_DEFINITION: Readonly<Record<StackRole, string>> = { broker: "stack-broker", auth: "stack-auth", delivery: "stack-delivery", manager: "stack-manager" };
export const STACK_ADAPTER: Readonly<Record<StackRole, string>> = { broker: "nats-broker", auth: "auth-service", delivery: "delivery", manager: "manager-service" };

export const STACK_MODES = ["auth", "open", "user"] as const;
export type StackMode = (typeof STACK_MODES)[number];

/** Which roles a mode can ever plan. An open stack has no delivery; only a user stack has an auth
 *  service. A role outside its mode stays `not-attempted` with no instance, and validation refuses
 *  any other shape. */
export function stackRoleApplies(mode: StackMode, role: StackRole): boolean {
  return role === "auth" ? mode === "user" : role === "delivery" ? mode !== "open" : true;
}

export type StackMemberState = "planned" | "not-attempted" | "started" | "reused" | "stopped" | "already-stopped" | "refused" | "failed" | "unknown";
export interface StackMember { role: StackRole; definition: string; instanceId: string | null; state: StackMemberState; code?: string }
export interface StackJournal {
  schemaVersion: 1;
  kind: "cotal-stack-controller";
  root: string;
  space: string;
  server: string;
  /** Pinned at the first whole-stack up. An open stack has no delivery member and no credential;
   *  only a user stack has an auth-service member. */
  mode: StackMode;
  members: StackMember[];
  /** The broker inputs this stack's broker was last prepared from. A later preparation of the same
   *  stopped broker reuses them rather than a default store, and an explicit request that differs
   *  refuses. Absent on journals written before they were recorded. */
  broker?: StackBrokerInputs;
  operation: { id: string; kind: "up" | "down" | "preserve" | "resume"; phase: "planned" | "applying" | "completed" | "partial" | "unknown" | "refused" | "failed"; recordedAt: string; withAgents: boolean;
    /** The maintenance attempt a preserve or resume serves. Required for those kinds, absent otherwise;
     *  the maintenance journal stays the authority for the attempt's state and evidence. */
    maintenanceAttemptId?: string };
  updatedAt: string;
}

const LIMIT = 64 * 1024;
const PHASES = ["planned", "applying", "completed", "partial", "unknown", "refused", "failed"];
const STATES = ["planned", "not-attempted", "started", "reused", "stopped", "already-stopped", "refused", "failed", "unknown"];
/** The maintenance journal's attempt-id token form (workspace maintenance.ts ATTEMPT_ID). */
const MAINTENANCE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export { stackJournalPath };

function invalid(): never {
  throw new CommandFailure("refused", "SCHEMA_INVALID", "the stack journal has an unsupported shape; no stack membership or stopped state was inferred", { remedy: "inspect <root>/.cotal/stack-controller.json and the service instances it names; it was not reset" });
}

function validate(input: unknown, root: string): StackJournal {
  const value = localRecordObject(input, ["schemaVersion", "kind", "root", "space", "server", "mode", "members", "broker", "operation", "updatedAt"]);
  // A journal written before the auth-service role existed carries exactly broker, delivery and
  // manager rows. It is read with an explicit not-attempted auth row for auth/open stacks only;
  // the next write records the current shape. A user stack never has that legacy shape.
  if (Array.isArray(value.members) && value.members.length === STACK_ROLES.length - 1 && value.mode !== "user" && value.members.every((row, index) => (row as { role?: unknown })?.role === ["broker", "delivery", "manager"][index]))
    value.members = [value.members[0], { role: "auth", definition: STACK_DEFINITION.auth, instanceId: null, state: "not-attempted" }, ...value.members.slice(1)];
  if (value.schemaVersion !== 1 || value.kind !== "cotal-stack-controller" || value.root !== root || typeof value.space !== "string" || !value.space || typeof value.server !== "string" || !value.server || !STACK_MODES.includes(value.mode as StackMode) || typeof value.updatedAt !== "string" || !Array.isArray(value.members) || value.members.length !== STACK_ROLES.length) invalid();
  const members = (value.members as unknown[]).map((row, index) => {
    const member = localRecordObject(row, ["role", "definition", "instanceId", "state", "code"]);
    const role = STACK_ROLES[index]!;
    if (member.role !== role || member.definition !== STACK_DEFINITION[role] || !STATES.includes(String(member.state)) || member.code !== undefined && (typeof member.code !== "string" || !/^[A-Z_]{1,64}$/.test(member.code))) invalid();
    if (member.instanceId !== null) { try { serviceOperationId(member.instanceId); } catch { invalid(); } }
    if (!stackRoleApplies(value.mode as StackMode, role) && (member.instanceId !== null || member.state !== "not-attempted")) invalid();
    return member as unknown as StackMember;
  });
  const operation = localRecordObject(value.operation, ["id", "kind", "phase", "recordedAt", "withAgents", "maintenanceAttemptId"]);
  try { serviceOperationId(operation.id); } catch { invalid(); }
  if (!["up", "down", "preserve", "resume"].includes(String(operation.kind)) || !PHASES.includes(String(operation.phase)) || typeof operation.recordedAt !== "string" || typeof operation.withAgents !== "boolean") invalid();
  const maintained = operation.kind === "preserve" || operation.kind === "resume";
  if (maintained !== (operation.maintenanceAttemptId !== undefined) || maintained && (operation.withAgents !== false || typeof operation.maintenanceAttemptId !== "string" || !MAINTENANCE_ATTEMPT_ID.test(operation.maintenanceAttemptId))) invalid();
  const broker = value.broker === undefined ? undefined : brokerInputs(value.broker);
  const { broker: _broker, ...rest } = value as unknown as StackJournal;
  return { ...rest, members, ...(broker ? { broker } : {}), operation: operation as unknown as StackJournal["operation"] };
}

export interface StackBrokerInputs { storeDir: string; maxFileStore?: number; host?: string }

function brokerInputs(input: unknown): StackBrokerInputs {
  const value = localRecordObject(input, ["storeDir", "maxFileStore", "host"]);
  if (typeof value.storeDir !== "string" || !isAbsolute(value.storeDir) || value.storeDir.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.storeDir)) invalid();
  if (value.maxFileStore !== undefined && (!Number.isSafeInteger(value.maxFileStore) || Number(value.maxFileStore) <= 0)) invalid();
  if (value.host !== undefined && (typeof value.host !== "string" || !value.host || value.host.length > 253 || /[\u0000- \u007f]/u.test(value.host))) invalid();
  return { storeDir: value.storeDir as string, ...(value.maxFileStore !== undefined ? { maxFileStore: Number(value.maxFileStore) } : {}), ...(value.host !== undefined ? { host: value.host as string } : {}) };
}

export interface StackJournalSnapshot { journal: StackJournal; sha256: string }

export function readStackJournal(root: string): StackJournalSnapshot | undefined {
  const canonical = canonicalRoot(root);
  const bytes = readLocalRecordSource(stackJournalPath(canonical), LIMIT, true);
  if (!bytes) return undefined;
  return { journal: validate(decodeLocalJson(bytes), canonical), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** A controller-owned stack cannot be preserved in this release, so its preserve, and the backup and
 *  restore that need a preserved cut, refuse while validating, before the seed or any effect. A
 *  root with no stack journal keeps its legacy route. */
export function refuseControllerCut(root: string, action: "down --preserve-state" | "backup create" | "backup restore" | "up --restore"): void {
  const recorded = readStackJournal(root);
  if (!recorded) return;
  const preserve = action === "down --preserve-state";
  throw new CommandFailure("refused", "UNSUPPORTED", preserve
    ? "a controller-owned stack cannot be preserved in this release; nothing was stopped or written"
    : `${action} needs a preserved cut, and a controller-owned stack cannot be preserved in this release; nothing was written`, {
    target: { root: recorded.journal.root, space: recorded.journal.space },
    remedy: preserve
      ? "stop the stack with plain `cotal down`, which keeps its store, channels and history for the next `cotal up`; preserve on a controller-owned stack returns in a later release"
      : "plain `cotal down` and `cotal up` keep this stack's store, channels and history; backup and restore of a controller-owned stack return in a later release",
  });
}

/** Compare-and-replace under a private lock beside the journal. A changed journal refuses. */
export function writeStackJournal(root: string, expected: StackJournalSnapshot | undefined, next: StackJournal): StackJournalSnapshot {
  const canonical = canonicalRoot(root);
  validate(next, canonical);
  const lock = acquireLock(`${stackJournalPath(canonical)}.lock`, { label: "stack journal", onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds the stack journal") });
  try {
    const current = readStackJournal(canonical);
    if ((current?.sha256 ?? null) !== (expected?.sha256 ?? null)) throw new CommandFailure("refused", "CONFLICT", "the stack journal changed during this operation; nothing was replaced");
    const text = JSON.stringify(next, null, 2) + "\n";
    writeSecretFileAtomic(stackJournalPath(canonical), text);
    return { journal: next, sha256: createHash("sha256").update(text).digest("hex") };
  } finally { lock.release(); }
}

/** Whether the root's maintenance journal fences this stack. A settled active controller restore of
 *  this same stack does not; its attempt is returned so the caller names it
 *  in its result. Any other journal fences. The journal is only read. */
export function stackMaintenanceFence(root: string, journal: StackJournal): { fenced: boolean; admittedRestore?: string } {
  if (!readMaintenanceJournal(root)) return { fenced: false };
  const admitted = admittedControllerRestore(root, controllerStackView(journal));
  return admitted ? { fenced: false, admittedRestore: admitted.restore.attemptId } : { fenced: true };
}

/** The settled active controller restore that no longer fences this root's own stack, if any. */
export function admittedStackRestore(root: string): string | undefined {
  const canonical = canonicalRoot(root);
  const journal = readStackJournal(canonical)?.journal;
  return journal ? stackMaintenanceFence(canonical, journal).admittedRestore : undefined;
}

/** The stack facts a controller restore admission compares. */
function controllerStackView(journal: StackJournal): ControllerStackView {
  return { space: journal.space, server: journal.server, ...(journal.broker ? { storeDir: journal.broker.storeDir } : {}), operation: { id: journal.operation.id, phase: journal.operation.phase } };
}

/** The stack facts `maintenanceAdmitsStackWork` compares while a root holds a maintenance journal.
 *  The broker adapter and a service restart read them here; a manager-service launch carries them,
 *  because that adapter reads no stack journal. Undefined without a maintenance journal or when the
 *  root's stack journal names another space. */
export function maintenanceStackView(root: string, space: string): ControllerStackView | undefined {
  const canonical = canonicalRoot(root);
  if (!readMaintenanceJournal(canonical)) return undefined;
  const journal = readStackJournal(canonical)?.journal;
  return journal?.space === space ? controllerStackView(journal) : undefined;
}

export function newStackOperation(kind: "up" | "down", withAgents = false): StackJournal["operation"] {
  return { id: randomUUID(), kind, phase: "planned", recordedAt: new Date().toISOString(), withAgents };
}

/** Legacy pidfile records under the root that may front a process, excluding the settled records
 *  the stack's own controller children publish for themselves: a record counts as owned only when
 *  its PID is the live creation-pinned process of a stack member instance. Nothing is adopted. */
export function foreignLocalProcesses(root: string, space: string): string[] {
  const owned = new Set<number>();
  for (const name of Object.values(STACK_DEFINITION))
    for (const row of serviceInstances(space, name)) if (row.record.value.process && observeServiceProcess(row.record.value) === "running") owned.add(row.record.value.process.pid);
  const foreign: string[] = [];
  for (const component of localProcessSurface()) {
    const raw = readPidfile(localProcessPath(component.pidFile, { root, space }));
    if (!raw) continue;
    const pid = parsePid(raw);
    if (pid !== undefined && owned.has(pid)) continue;
    if (pid === undefined || probeLiveness(pid) !== "dead") foreign.push(`${component.name}${pid === undefined ? " (unattributable record)" : ` (pid ${pid})`}`);
  }
  return foreign;
}

/** A record under a root that may still front a process: whose descriptor names it, its path
 *  relative to the root, the pid it holds when one parses, and why it counts. */
export interface RecordedProcess { readonly name: string; readonly path: string; readonly pid?: number; readonly note: string }

/** How a refusal lists one record: `<name> at <path> (<note>)`. */
export const recordedProcessLine = (row: RecordedProcess): string => `${row.name} at ${row.path} (${row.note})`;

/** Every local-process record under the root that may still front a process. Each descriptor's
 *  candidates are read for `spaces`, and a `{space}` template's records for any other space are
 *  found by listing what it names under `.cotal`. A live or unanswered pid, an unattributable or
 *  unreadable record, a record whose space segment decodes to no space and a directory that cannot
 *  be listed all count; only an empty or ESRCH-proven dead record of a known space does not. Read
 *  only: nothing is stopped, adopted or removed. */
export function recordedProcessesUnder(root: string, spaces: readonly string[]): RecordedProcess[] {
  const found: RecordedProcess[] = [], seen = new Set<string>();
  const read = (name: string, path: string, attributed: boolean): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const at = { name, path: relative(root, path) };
    let raw: string | undefined;
    try { raw = readPidfile(path); } catch { found.push({ ...at, note: "unreadable record" }); return; }
    if (raw === undefined) return; // removed since the listing
    const pid = raw ? parsePid(raw) : undefined;
    if (!attributed) found.push({ ...at, ...(pid === undefined ? {} : { pid }), note: pid === undefined ? "unattributable record name" : `unattributable record name, pid ${pid}` });
    else if (raw && pid === undefined) found.push({ ...at, note: "unattributable record" });
    else if (pid !== undefined && probeLiveness(pid) !== "dead") found.push({ ...at, pid, note: `pid ${pid}` });
  };
  for (const component of localProcessSurface()) {
    for (const space of spaces) for (const path of localProcessPathCandidates(component.pidFile, { root, space })) read(component.name, path, true);
    if (!component.pidFile.includes("{space}")) continue;
    for (const match of recordedLocalProcessPaths(component.pidFile, root)) {
      if (!match.unlisted) read(component.name, match.path, match.space !== undefined);
      else if (!seen.has(match.path)) { seen.add(match.path); found.push({ name: component.name, path: relative(root, match.path), note: "directory could not be listed" }); }
    }
  }
  return found;
}

/** An observed process state that counts as stopped for a whole-stack stop. */
export const processGone = (state: string) => state === "gone" || state === "previous-boot" || state === "foreign-pid";

/** What stopping the stack's broker would cut off outside its recorded members refuses before the
 *  first signal: another live or unresolved service instance in the space, a legacy pidfile process
 *  under the root, or another registration that names the same broker address. Bare `down` and
 *  `down --preserve-state` both run it; `next` is the command to run once the named dependants are
 *  stopped. */
export function stackScopeRefusals(journal: StackJournal, next: string): void {
  const memberIds = new Set(journal.members.flatMap((row) => row.instanceId === null ? [] : [row.instanceId]));
  const others = serviceInstances(journal.space).filter((row) => !memberIds.has(row.name) && (!processGone(observeServiceProcess(row.record.value)) || ["starting", "stopping", "unknown"].includes(row.record.value.state)));
  if (others.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "other service instances in this space are live or unresolved and depend on its broker; the broker was not stopped under them", { target: { space: journal.space, dependants: others.map((row) => ({ definition: row.record.value.definition, instanceId: row.name })) }, remedy: `stop ${[...new Set(others.map((row) => row.record.value.definition))].join(", ")} explicitly with cotal svc stop <name>, then run ${next}` });
  const legacy = foreignLocalProcesses(journal.root, journal.space);
  if (legacy.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "legacy pidfile-owned processes under this root may depend on the broker; they were neither adopted nor stopped", { target: { root: journal.root, processes: legacy } });
  const sharing = loadMeshes().filter((mesh) => mesh.space !== journal.space && mesh.server === journal.server);
  if (sharing.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another registration names this stack's exact broker address; a shared broker is not stopped in this cut", { target: { server: journal.server, spaces: sharing.map((mesh) => mesh.space) } });
}
