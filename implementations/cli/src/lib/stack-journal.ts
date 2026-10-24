/** The root-local whole-stack journal: which controller definitions and full instances one local
 *  stack owns, and the last whole-stack operation's per-member outcome. One owner-private file at
 *  `<root>/.cotal/stack-controller.json`. It is not a service record, unit receipt or team ledger,
 *  and it grants no stop authority by itself: every effect still rechecks the instance records. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { acquireLock, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, acquireMaintenanceLock, admittedControllerRestore, canonicalRoot, decodeLocalJson, isCommandFailure, isMaintenanceError, loadMeshes, localProcessPath, localProcessPathCandidates, localRecordObject, maintenancePaths, parsePid, probeLiveness, readContainedRecord, readLocalRecordSource, readMaintenanceJournal, readPidfile, recordedLocalProcessPaths, releaseMaintenanceLock, serviceOperationId, stackJournalPath, maintenanceLockHolder, cotalDirLink, preparedSpaceAt, stackAdoptionBlock, stackElsewhereRemedy, type ControllerStackView, type MaintenanceLock, type ServiceAdapterStopAbandonment } from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { observeServiceProcess, serviceInstances, type ServiceInstance, type ServiceInstanceSnapshot } from "./service-instances.js";
import { stackRunsRecord, type StackRuns } from "./stack-runs.js";
import { abandonableSignalStop, abandonRetainedNativeStop, abandonRetainedSignalStop, removableServiceInstances, removeStoppedInstanceRecords, resumableSignalStop, retainedStopMaySettle, retainedStopRequest, settleExitedInstance, settleRetainedNativeStop } from "./service-process.js";

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
/** A redefinition in flight: the instance an `up` launches for a member after it retires the
 *  member's recorded instance with the old definition. Its IDs are journaled before that retirement
 *  and the new definition's revision before the launch, so a crash in between is resolved from the
 *  replacement's own record (see {@link withSettledMembers}). */
export interface StackReplacement { operation: string; instanceId: string; launchRequestId: string; definitionRevision?: string }
export interface StackMember { role: StackRole; definition: string; instanceId: string | null; state: StackMemberState; code?: string; replacement?: StackReplacement }
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
    maintenanceAttemptId?: string;
    /** The workflow runs the manager hosted, read just before a down stopped it. Only a down
     *  carries it, so the next operation drops it. */
    runs?: StackRuns };
  updatedAt: string;
}

const LIMIT = 64 * 1024;
const PHASES = ["planned", "applying", "completed", "partial", "unknown", "refused", "failed"];
const STATES = ["planned", "not-attempted", "started", "reused", "stopped", "already-stopped", "refused", "failed", "unknown"];
/** The maintenance journal's attempt-id token form (workspace maintenance.ts ATTEMPT_ID). */
const MAINTENANCE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export { stackJournalPath };

function invalid(root: string): never {
  throw new CommandFailure("refused", "SCHEMA_INVALID", "the stack journal has an unsupported shape; no stack membership or stopped state was inferred", { remedy: `inspect ${stackJournalPath(root)} and the service instances it names; it was not reset` });
}

/** A well-formed journal that another folder recorded: this folder's `.cotal` links to that folder's,
 *  or this folder was moved or copied after that stack started there. Its members and instances
 *  belong to that folder, so nothing here uses them. The next step is the one every command there names. */
function recordedElsewhere(root: string, recordedRoot: string, space: string, members: readonly StackMember[]): never {
  const link = cotalDirLink(root), remedy = stackElsewhereRemedy(root, recordedRoot, space, members);
  if (link !== undefined)
    throw new CommandFailure("refused", "CONFLICT", `${join(root, ".cotal")} is a link to ${link}, whose stack journal was recorded at ${recordedRoot}; a controller stack runs only from the folder it started in`, { target: { root, recordedRoot, space, link }, remedy });
  // The recorded root still holds its journal after a copy; after a move it does not, even where a
  // running broker created empty folders at that path again.
  const moved = !existsSync(stackJournalPath(recordedRoot));
  throw new CommandFailure("refused", "CONFLICT", `this folder's stack journal was recorded at ${recordedRoot}, so this folder was ${moved ? "moved" : "copied"} from there; a controller stack runs only from the folder it started in`, { target: { root, recordedRoot, space }, remedy });
}

/** A journal whose bytes are not JSON, as an interrupted write or a full disk can leave it. Removing it
 *  is the way out once no member of its stack runs, so the remedy names any running member's stop
 *  first, from the service records of the spaces at this root. */
function unreadable(root: string): never {
  const path = stackJournalPath(root);
  let running: { space: string; name: string; instanceId: string }[] | undefined;
  try {
    const spaces = new Set([...loadMeshes().filter((mesh) => canonicalRoot(mesh.root) === root).map((mesh) => mesh.space), ...[preparedSpaceAt(root)?.space].filter((space): space is string => space !== undefined)]);
    running = [...spaces].flatMap((space) => [...STACK_ROLES].reverse().flatMap((role) => serviceInstances(space, STACK_DEFINITION[role])
      .filter((row) => observeServiceProcess(row.record.value) === "running")
      .map((row) => ({ space, name: STACK_DEFINITION[role], instanceId: row.record.value.instanceId }))));
  } catch {
    running = undefined;
  }
  throw new CommandFailure("refused", "SCHEMA_INVALID", `the stack journal ${path} is not valid JSON, as an interrupted write or a full disk can leave it; no stack membership or stopped state was inferred`, {
    target: { root, path },
    remedy: running === undefined
      ? `stop any running member of this stack with cotal service stop <name> --instance <id> --yes, manager first and broker last, then remove ${path} and run cotal up from ${root}`
      : running.length === 0
        ? `no member of this stack is running, so remove ${path}; the next cotal up from ${root} starts the stack again from its saved definitions`
        : `stop its running members with ${running.map((row) => `cotal service stop ${row.name} --instance ${row.instanceId} --space ${row.space} --yes`).join(", then ")}, then remove ${path} and run cotal up from ${root}`,
  });
}

function validate(input: unknown, root: string): StackJournal {
  const value = localRecordObject(input, ["schemaVersion", "kind", "root", "space", "server", "mode", "members", "broker", "operation", "updatedAt"]);
  // A journal written before the auth-service role existed carries exactly broker, delivery and
  // manager rows. It is read with an explicit not-attempted auth row for auth/open stacks only;
  // the next write records the current shape. A user stack never has that legacy shape.
  if (Array.isArray(value.members) && value.members.length === STACK_ROLES.length - 1 && value.mode !== "user" && value.members.every((row, index) => (row as { role?: unknown })?.role === ["broker", "delivery", "manager"][index]))
    value.members = [value.members[0], { role: "auth", definition: STACK_DEFINITION.auth, instanceId: null, state: "not-attempted" }, ...value.members.slice(1)];
  if (value.schemaVersion !== 1 || value.kind !== "cotal-stack-controller" || typeof value.root !== "string" || !isAbsolute(value.root) || typeof value.space !== "string" || !value.space || typeof value.server !== "string" || !value.server || !STACK_MODES.includes(value.mode as StackMode) || typeof value.updatedAt !== "string" || !Array.isArray(value.members) || value.members.length !== STACK_ROLES.length) invalid(root);
  const members = (value.members as unknown[]).map((row, index) => {
    const member = localRecordObject(row, ["role", "definition", "instanceId", "state", "code", "replacement"]);
    const role = STACK_ROLES[index]!;
    if (member.role !== role || member.definition !== STACK_DEFINITION[role] || !STATES.includes(String(member.state)) || member.code !== undefined && (typeof member.code !== "string" || !/^[A-Z_]{1,64}$/.test(member.code))) invalid(root);
    if (member.instanceId !== null) { try { serviceOperationId(member.instanceId); } catch { invalid(root); } }
    if (member.replacement !== undefined) replacementOf(member.replacement, root);
    if (!stackRoleApplies(value.mode as StackMode, role) && (member.instanceId !== null || member.state !== "not-attempted" || member.replacement !== undefined)) invalid(root);
    return member as unknown as StackMember;
  });
  const operation = localRecordObject(value.operation, ["id", "kind", "phase", "recordedAt", "withAgents", "maintenanceAttemptId", "runs"]);
  if (operation.runs !== undefined && (operation.kind !== "down" || stackRunsRecord(operation.runs) === undefined)) invalid(root);
  try { serviceOperationId(operation.id); } catch { invalid(root); }
  if (!["up", "down", "preserve", "resume"].includes(String(operation.kind)) || !PHASES.includes(String(operation.phase)) || typeof operation.recordedAt !== "string" || typeof operation.withAgents !== "boolean") invalid(root);
  const maintained = operation.kind === "preserve" || operation.kind === "resume";
  if (maintained !== (operation.maintenanceAttemptId !== undefined) || maintained && (operation.withAgents !== false || typeof operation.maintenanceAttemptId !== "string" || !MAINTENANCE_ATTEMPT_ID.test(operation.maintenanceAttemptId))) invalid(root);
  const broker = value.broker === undefined ? undefined : brokerInputs(value.broker, root);
  if (value.root !== root) recordedElsewhere(root, value.root as string, value.space as string, members);
  const { broker: _broker, ...rest } = value as unknown as StackJournal;
  return { ...rest, members, ...(broker ? { broker } : {}), operation: operation as unknown as StackJournal["operation"] };
}

function replacementOf(input: unknown, root: string): StackReplacement {
  const value = localRecordObject(input, ["operation", "instanceId", "launchRequestId", "definitionRevision"]);
  try { for (const id of [value.operation, value.instanceId, value.launchRequestId, ...(value.definitionRevision === undefined ? [] : [value.definitionRevision])]) serviceOperationId(id); } catch { invalid(root); }
  return value as unknown as StackReplacement;
}

export interface StackBrokerInputs { storeDir: string; maxFileStore?: number; host?: string }

function brokerInputs(input: unknown, root: string): StackBrokerInputs {
  const value = localRecordObject(input, ["storeDir", "maxFileStore", "host"]);
  if (typeof value.storeDir !== "string" || !isAbsolute(value.storeDir) || value.storeDir.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.storeDir)) invalid(root);
  if (value.maxFileStore !== undefined && (!Number.isSafeInteger(value.maxFileStore) || Number(value.maxFileStore) <= 0)) invalid(root);
  if (value.host !== undefined && (typeof value.host !== "string" || !value.host || value.host.length > 253 || /[\u0000- \u007f]/u.test(value.host))) invalid(root);
  return { storeDir: value.storeDir as string, ...(value.maxFileStore !== undefined ? { maxFileStore: Number(value.maxFileStore) } : {}), ...(value.host !== undefined ? { host: value.host as string } : {}) };
}

export interface StackJournalSnapshot { journal: StackJournal; sha256: string }

export function readStackJournal(root: string): StackJournalSnapshot | undefined {
  const canonical = canonicalRoot(root);
  const bytes = readLocalRecordSource(stackJournalPath(canonical), LIMIT, true);
  if (!bytes) return undefined;
  let input: unknown;
  try { input = decodeLocalJson(bytes); }
  catch (error) { if (isCommandFailure(error)) unreadable(canonical); throw error; }
  return { journal: validate(input, canonical), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The stack journal at `root` that another folder recorded, as a copy or a moved folder keeps it, with
 *  that folder. Undefined when `root` has no journal or recorded it itself. */
export function journalRecordedElsewhere(root: string): { journal: StackJournal; recordedRoot: string; sha256: string } | undefined {
  const canonical = canonicalRoot(root);
  const bytes = readLocalRecordSource(stackJournalPath(canonical), LIMIT, true);
  if (!bytes) return undefined;
  let input: unknown;
  try { input = decodeLocalJson(bytes); }
  catch (error) { if (isCommandFailure(error)) unreadable(canonical); throw error; }
  const recordedRoot = (input as { root?: unknown } | null)?.root;
  if (typeof recordedRoot !== "string" || recordedRoot === canonical) return undefined;
  // Validated as if recorded here, so a shape refusal names this folder's journal.
  return { journal: validate({ ...(input as object), root: canonical }, canonical), recordedRoot, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Why `space create --adopt` would refuse the journal {@link journalRecordedElsewhere} found at
 *  `root`, as the message and the next step; undefined when it would adopt it. */
export function adoptionRefusal(root: string, found: { journal: StackJournal; recordedRoot: string }): { message: string; remedy: string } | undefined {
  return stackAdoptionBlock(canonicalRoot(root), found.recordedRoot, found.journal.space, found.journal.members);
}

/** `space create --adopt`: rewrite, at `root`, the stack journal another folder recorded, as a copy
 *  from another machine or a folder moved after its stack stopped keeps it, so it names this root.
 *  It refuses as {@link stackAdoptionBlock} says. The adopted journal keeps the space, address, mode and
 *  broker inputs, with a store that lay under the recorded root moved under this one, and records an
 *  up refused before any member started, as a stack that never ran here. Returns the recorded root. */
export function adoptStackJournal(root: string, space: string): string {
  const canonical = canonicalRoot(root), path = stackJournalPath(canonical);
  const lock = acquireLock(`${path}.lock`, { label: "stack journal", onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds the stack journal") });
  try {
    const found = journalRecordedElsewhere(canonical);
    if (!found) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${canonical} holds no stack journal another folder recorded, so there is nothing to adopt; nothing was written`, { target: { root: canonical, space }, remedy: `run cotal space create ${space} --root ${canonical} without --adopt` });
    if (found.journal.space !== space) throw new CommandFailure("refused", "CONFLICT", `the stack journal in ${canonical} is for "${found.journal.space}", not "${space}"; nothing was written`, { target: { root: canonical, space, journalSpace: found.journal.space }, remedy: `adopt it with cotal space create ${found.journal.space} --adopt --root ${canonical}` });
    const block = stackAdoptionBlock(canonical, found.recordedRoot, space, found.journal.members);
    if (block) throw new CommandFailure("refused", "CONFLICT", `${block.message}; it was not adopted and nothing was written`, { target: { root: canonical, recordedRoot: found.recordedRoot, space }, remedy: block.remedy });
    const under = (path: string) => { const rest = relative(found.recordedRoot, path); return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest) ? join(canonical, rest) : path; };
    const now = new Date().toISOString();
    const next: StackJournal = {
      schemaVersion: 1, kind: "cotal-stack-controller", root: canonical, space, server: found.journal.server, mode: found.journal.mode,
      members: STACK_ROLES.map((role) => ({ role, definition: STACK_DEFINITION[role], instanceId: null, state: "not-attempted" })),
      ...(found.journal.broker ? { broker: { ...found.journal.broker, storeDir: under(found.journal.broker.storeDir) } } : {}),
      operation: { id: randomUUID(), kind: "up", phase: "refused", recordedAt: now, withAgents: false },
      updatedAt: now,
    };
    validate(next, canonical);
    writeSecretFileAtomic(path, JSON.stringify(next, null, 2) + "\n");
    return found.recordedRoot;
  } finally { lock.release(); }
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

/** Take the root's maintenance lock for one whole-stack operation. Every whole-stack operation
 *  holds it for its whole run, and a dead holder is reclaimed only when its PID is proven dead. A
 *  live holder is a known refusal that names its PID; nothing was read or changed.
 *  Taking the lock creates the root's `.cotal/maintenance` folders when they are missing. A command
 *  that then ends refused or failed releases the lock if it still holds it, and removes the folders
 *  the lock created while they are still empty, so a refusal leaves the folder as it found it. */
export function acquireStackOperationLock(root: string): MaintenanceLock {
  const paths = maintenancePaths(root);
  const created = [paths.versionDir, paths.maintenanceDir, paths.cotalDir].filter((dir) => !existsSync(dir));
  let lock: MaintenanceLock;
  try { lock = acquireMaintenanceLock(root); }
  catch (error) {
    if (!isMaintenanceError(error) || error.code !== "lock-held") throw error;
    let holder: number | undefined;
    try { holder = (decodeLocalJson(readLocalRecordSource(paths.lock, 64 * 1024) ?? Buffer.from("null")) as { owner?: { pid?: unknown } } | null)?.owner?.pid as number | undefined; } catch { holder = undefined; }
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `another whole-stack or maintenance operation holds this root${Number.isSafeInteger(holder) ? ` (pid ${holder})` : ""}; nothing was changed`, { target: { root, ...(Number.isSafeInteger(holder) ? { holderPid: holder } : {}) }, remedy: "run the command again after that operation exits; a foreground cotal up holds the root only while it starts" });
  }
  // An exit through process.exit skips the caller's release, so the lock is checked here as well.
  process.once("exit", (code) => {
    if (code === 0) return;
    try {
      const held = (decodeLocalJson(readLocalRecordSource(lock.path, 64 * 1024) ?? Buffer.from("null")) as { token?: unknown } | null)?.token === lock.token;
      if (held) releaseMaintenanceLock(lock);
    } catch { return; }
    // Deepest first. A folder that holds anything else was written by the command, and it stays.
    for (const dir of created) { try { rmdirSync(dir); } catch { return; } }
  });
  return lock;
}

/** An earlier operation that had no recorded outcome, and the member evidence it was settled from. */
export interface StackSettlement { operation: StackJournal["operation"]; members: { role: StackRole; instanceId: string; process: "running" | "gone" }[] }

const UNSETTLED_PHASES: readonly StackJournal["operation"]["phase"][] = ["planned", "applying", "unknown"];

/** Whether the journal's last operation has no recorded outcome. */
export function stackOperationUnsettled(journal: StackJournal): boolean {
  return UNSETTLED_PHASES.includes(journal.operation.phase);
}

/** One stack definition's single instance, classified from its own record and exact process: live,
 *  or gone with nothing of ours in flight. With `settle`, the caller holds the root's maintenance
 *  lock and a crash is recorded under the definition's writer lock. Without it nothing is written.
 *  A member that is neither refuses, naming the instance and the read that shows it. */
function classifyStackMember(journal: StackJournal, role: StackRole, settle: boolean): StackSettlement["members"][number] | undefined {
  const space = journal.space, name = STACK_DEFINITION[role];
  const store = serviceDefinitionStore(space), definition = store.read(name);
  const target = { root: journal.root, space, operation: journal.operation.id, definition: name };
  const inspect = (instanceId: string) => `inspect it with cotal service status ${name} --instance ${instanceId} --space ${space}`;
  if (!definition) {
    const orphans = serviceInstances(space, name);
    if (orphans.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a stack member instance has no saved definition; the earlier operation was not settled", { target: { ...target, instances: orphans.map((row) => row.name) }, remedy: inspect(orphans[0]!.name) });
    return undefined;
  }
  const launch = definition.record.value.launch;
  if (launch.type !== "adapter" || launch.adapter !== STACK_ADAPTER[role] || launch.options.root !== journal.root)
    throw new CommandFailure("refused", "CONFLICT", "a saved definition under a stack name belongs to another adapter or root; the earlier operation was not settled", { target, remedy: `inspect cotal service show ${name} --space ${space}` });
  const hold = settle ? store.pin(definition) : undefined;
  try {
    const rows = serviceInstances(space, name);
    if (rows.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "a stack definition has several instance records; the earlier operation was not settled", { target: { ...target, candidates: rows.map((row) => row.name) } });
    if (!rows.length) return undefined;
    const row = settle ? settleExitedInstance(rows[0]!) : rows[0]!;
    const value: ServiceInstance = row.record.value, observed = observeServiceProcess(value);
    // A stop request the member retains is neither live nor gone here; only its own receipt settles
    // it. Read-only, a crash-like record whose launch holds one is found before the settlement would
    // record it `stopping`.
    const retained = retainedStopRequest(value), stopRetained = value.state === "stopping" || retained !== undefined;
    if (observed === "running" && !stopRetained) return { role, instanceId: row.name, process: "running" };
    const gone = processGone(observed);
    // Read-only, a crash is classified as the settled `failed` record it will become.
    if (gone && !stopRetained && (["failed", "stopped"].includes(value.state) || !settle && value.process !== undefined && ["starting", "running", "unknown"].includes(value.state))) return { role, instanceId: row.name, process: "gone" };
    // Nothing was changed by this command, so its own outcome is a known refusal.
    const route = memberStopRoute(value);
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", !stopRetained
      ? "a stack member's process is neither live nor proven gone, so the earlier whole-stack operation cannot be settled from evidence; nothing was retried"
      : retained?.publication === "unknown"
        ? "a stack member's stop request file does not read as its own, so whether a stop was published is unknown and the earlier whole-stack operation cannot be settled from evidence; nothing was retried"
        : "a stack member retains an unconfirmed stop request, so the earlier whole-stack operation cannot be settled from evidence; nothing was retried", { target: { ...target, instanceId: row.name, recordedState: value.state, process: observed, ...(stopRetained ? { requestId: retained?.requestId ?? value.requestId, ...(retained ? { stopPublication: retained.publication } : {}) } : {}) }, remedy: route.kind === "abandon" ? `${inspect(row.name)}; ${abandonRemedy(route.requestId)}` : route.kind === "resume" ? `${inspect(row.name)}; ${RESUME_REMEDY}` : inspect(row.name) });
  } finally { hold?.release(); }
}

/** The way out a refusal of `value` names: abandon the stop it retains, signal its process again, or
 *  only inspect it. */
function memberStopRoute(value: ServiceInstance): { kind: "abandon"; requestId: string } | { kind: "resume" } | { kind: "inspect" } {
  const retained = retainedStopRequest(value);
  if (retained?.publication === "published") return { kind: "abandon", requestId: retained.requestId };
  if (abandonableSignalStop(value)) return { kind: "abandon", requestId: value.requestId };
  return { kind: resumableSignalStop(value) ? "resume" : "inspect" };
}

/** A member that keeps `up` and `down` from settling a cut-off operation, as {@link stackOperationBlock}
 *  reads it. */
export interface StackOperationBlock {
  operation: { id: string; kind: StackJournal["operation"]["kind"] };
  definition: string;
  instanceId: string;
  /** Why the stack is in this state. */
  reason: string;
  route: { kind: "abandon"; requestId: string } | { kind: "inspect" };
}

/** What keeps `up` and `down` from settling this journal's operation, which ended with no recorded
 *  outcome: the member their refusal names, why, and the way out it names. Read as `down --dry-run`
 *  reads it, with nothing written. Undefined when the operation is settled or settles from its
 *  members' processes, and when a member's retained stop may settle before they classify it, which
 *  for a native stop only its adapter's receipts decide. */
export function stackOperationBlock(journal: StackJournal): StackOperationBlock | undefined {
  try { previewStackSettlement(journal); return undefined; }
  catch (error) {
    const target = isCommandFailure(error) && error.code === "LIFECYCLE_BLOCKED" ? error.target as { definition?: unknown; instanceId?: unknown } | undefined : undefined;
    if (typeof target?.definition !== "string" || typeof target.instanceId !== "string") throw error;
    const row = serviceInstances(journal.space, target.definition).find((item) => item.name === target.instanceId);
    if (!row) throw error;
    const value = row.record.value, route = memberStopRoute(value);
    if (retainedStopMaySettle(value) || route.kind === "resume") return undefined;
    const operation = `the earlier ${journal.operation.kind === "down" ? "whole-stack stop" : journal.operation.kind} ${journal.operation.id}`;
    return {
      operation: { id: journal.operation.id, kind: journal.operation.kind },
      definition: target.definition, instanceId: target.instanceId, route,
      reason: route.kind === "abandon"
        ? `${operation} asked ${target.definition} to stop and ended before it saw the process exit, and the process is gone, so up and down refuse until the stop is abandoned`
        : `${operation} ended with no recorded outcome, and ${target.definition} is neither proven running nor proven stopped, so up and down refuse until it is inspected`,
    };
  }
}

/** Settle each member's retained native stop from its adapter's own receipt, under that member's
 *  definition lock, before an `up` or `down` classifies the members. The caller holds the root's
 *  maintenance lock. A member whose adapter confirms less keeps its stop, and the classification
 *  refuses it as before. A preserve or resume with no outcome is left to its maintenance attempt. */
export async function settleRetainedStackStops(journal: StackJournal): Promise<void> {
  if (stackOperationUnsettled(journal) && journal.operation.kind !== "up" && journal.operation.kind !== "down") return;
  const store = serviceDefinitionStore(journal.space);
  for (const role of STACK_ROLES.filter((entry) => stackRoleApplies(journal.mode, entry))) {
    const definition = store.read(STACK_DEFINITION[role]), launch = definition?.record.value.launch;
    if (!definition || launch?.type !== "adapter" || launch.adapter !== STACK_ADAPTER[role] || launch.options.root !== journal.root) continue;
    const hold = store.pin(definition);
    try { for (const row of serviceInstances(journal.space, definition.name)) await settleRetainedNativeStop(definition, row); }
    finally { hold.release(); }
  }
}

/** The step for a member stop whose process still runs after the command that sent it exited. */
export const RESUME_REMEDY = "once the command that sent the stop has exited, `cotal down --yes` signals the process again";

/** The remedy a refusal over a retained, published member stop names. */
export const abandonRemedy = (requestId: string): string => `once its process and the down that sent the request have exited, \`cotal down --abandon-stop ${requestId} --yes\` abandons it`;

/** Abandon the one member stop that retains `requestId`, on an operator's explicit request, under that
 *  member's definition lock, before a `down` classifies the members. The caller holds the root's
 *  maintenance lock. A native stop is abandoned through its adapter, and a broker's or another
 *  member's signal stop once its process is gone. No member retaining it refuses `TARGET_NOT_FOUND`,
 *  and nothing is written. */
export async function abandonRetainedStackStop(journal: StackJournal, requestId: string): Promise<{ role: StackRole; row: ServiceInstanceSnapshot; abandonment: ServiceAdapterStopAbandonment }> {
  const store = serviceDefinitionStore(journal.space);
  for (const role of STACK_ROLES.filter((entry) => stackRoleApplies(journal.mode, entry))) {
    const definition = store.read(STACK_DEFINITION[role]), launch = definition?.record.value.launch;
    if (!definition || launch?.type !== "adapter" || launch.adapter !== STACK_ADAPTER[role] || launch.options.root !== journal.root) continue;
    const hold = store.pin(definition);
    try {
      const rows = serviceInstances(journal.space, definition.name);
      const row = rows.find((entry) => retainedStopRequest(entry.record.value)?.requestId === requestId);
      if (row) return { role, ...await abandonRetainedNativeStop(definition, row, requestId) };
      const signalled = rows.find((entry) => !entry.record.value.nativeStopRequired && entry.record.value.state === "stopping" && entry.record.value.requestId === requestId);
      if (signalled) return { role, row: abandonRetainedSignalStop(signalled, requestId), abandonment: { requestId, nativeStop: "abandoned", receipts: [], withAgents: false, cleanup: "not-checked" } };
    } finally { hold.release(); }
  }
  throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no member of this stack retains a stop request with that ID; nothing was abandoned", { target: { root: journal.root, space: journal.space, requestId }, remedy: `run \`cotal down --dry-run\` to see what blocks the stop, or \`cotal service status <definition> --instance <id> --space ${journal.space}\` for a member's request` });
}

/** Settle an earlier `up` or `down` that has no recorded outcome, from evidence only. The caller
 *  holds the root's maintenance lock, which every whole-stack operation holds for its whole run, so
 *  none of them is in flight. Each member is then classified under its definition's writer lock, so
 *  no launch or stop of it is in flight either: its exact process runs, or it is proven gone (PID and
 *  creation token) and recorded so. The operation is recorded as failed. A member it planned is
 *  recorded as unknown when an instance exists and not attempted when none does. A member that is
 *  neither live nor proven gone refuses; instances settled before that refusal stay settled, and
 *  the operation stays unsettled. A settled journal, and a preserve or resume (decided by its
 *  maintenance attempt), are returned unchanged. */
export function settleStackOperation(lock: MaintenanceLock, snapshot: StackJournalSnapshot): { snapshot: StackJournalSnapshot; settled?: StackSettlement } {
  const journal = snapshot.journal, operation = journal.operation;
  if (!stackOperationUnsettled(journal) || operation.kind !== "up" && operation.kind !== "down") return { snapshot };
  if (lock.root !== journal.root) throw new CommandFailure("refused", "CONFLICT", "the held maintenance lock belongs to another root; the earlier operation was not settled", { target: { root: journal.root } });
  const members = STACK_ROLES.filter((role) => stackRoleApplies(journal.mode, role)).flatMap((role) => classifyStackMember(journal, role, true) ?? []);
  const settled = writeStackJournal(journal.root, snapshot, { ...journal, members: withSettledMembers(journal, { operation, members }).members.map((row) => row.state !== "planned" && row.state !== "unknown" ? row : members.some((member) => member.role === row.role) ? { ...row, state: "unknown", code: "OPERATION_UNKNOWN" } : { ...row, state: "not-attempted", code: undefined }), operation: { ...operation, phase: "failed" }, updatedAt: new Date().toISOString() });
  return { snapshot: settled, settled: { operation, members } };
}

/** The journal with each journaled replacement resolved, and each member row that has no recorded
 *  instance given the one the settlement classified under that member's stack definition. An `up`
 *  cut off during a member's readiness leaves that member's instance unrecorded; it is the stack's
 *  own member, never another dependant. */
export function withSettledMembers(journal: StackJournal, settlement: StackSettlement | undefined): StackJournal {
  const members = journal.members.map((row) => resolveReplacement(journal, row));
  return { ...journal, members: settlement ? members.map((row) => row.instanceId !== null ? row : { ...row, instanceId: settlement.members.find((member) => member.role === row.role)?.instanceId ?? null }) : members };
}

/** A member row with its journaled replacement resolved from the definition's single instance
 *  record. The recorded instance stays when the retirement never happened, and none remains when
 *  nothing was launched. The replacement is adopted only when its record carries the journaled
 *  launch request and definition revision, the saved definition is that revision, and this journal's
 *  operation journaled it. Any other record refuses, and nothing is adopted. */
function resolveReplacement(journal: StackJournal, row: StackMember): StackMember {
  const { replacement, ...member } = row;
  if (!replacement) return row;
  const space = journal.space, rows = serviceInstances(space, row.definition), found = rows[0];
  const target = { root: journal.root, space, operation: journal.operation.id, definition: row.definition, recorded: row.instanceId, replacement: replacement.instanceId, launchRequestId: replacement.launchRequestId, found: rows.map((item) => item.name) };
  if (rows.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "a stack definition has several instance records; the journaled replacement was not resolved", { target });
  if (!found) return { ...member, instanceId: null };
  if (found.name === row.instanceId) return member;
  const value = found.record.value;
  if (replacement.operation === journal.operation.id && replacement.definitionRevision !== undefined && found.name === replacement.instanceId && value.launchRequestId === replacement.launchRequestId && value.definitionRevision === replacement.definitionRevision && serviceDefinitionStore(space).read(row.definition)?.record.revision === replacement.definitionRevision)
    return { ...member, instanceId: found.name };
  throw new CommandFailure("refused", "CONFLICT", "the definition's instance record is not the replacement this stack journal recorded for its operation; neither was adopted", { target, remedy: `inspect it with cotal service status ${row.definition} --instance ${found.name} --space ${space}` });
}

/** The read-only classification `settleStackOperation` would record, for a preview. Writes nothing. */
export function previewStackSettlement(journal: StackJournal): StackSettlement | undefined {
  if (!stackOperationUnsettled(journal) || journal.operation.kind !== "up" && journal.operation.kind !== "down") return undefined;
  return { operation: journal.operation, members: STACK_ROLES.filter((role) => stackRoleApplies(journal.mode, role)).flatMap((role) => classifyStackMember(journal, role, false) ?? []) };
}

/** The one-line notice a command prints after it settled an earlier operation. */
export function stackSettlementNotice(settled: StackSettlement): string {
  const gone = settled.members.filter((row) => row.process === "gone").map((row) => row.role), running = settled.members.filter((row) => row.process === "running").map((row) => row.role);
  return `the earlier ${settled.operation.kind} ${settled.operation.id} had no recorded outcome; it was recorded as failed from its members' processes (gone: ${gone.join(", ") || "none"}; running: ${running.join(", ") || "none"})`;
}

export function newStackOperation(kind: "up" | "down", withAgents = false): StackJournal["operation"] {
  return { id: randomUUID(), kind, phase: "planned", recordedAt: new Date().toISOString(), withAgents };
}

/** Whether the stack's last `up` completed with its manager not attempted, as `up --no-manager`
 *  records it, so the stack runs no manager by choice. */
export function stackStartedWithoutManager(journal: StackJournal): boolean {
  return journal.operation.kind === "up" && journal.operation.phase === "completed" && journal.members.some((row) => row.role === "manager" && row.state === "not-attempted");
}

/** Whether an `up` on this root is starting the stack's manager for `space` now: the journal records
 *  an unsettled `up` that planned the manager, and a live process holds the root's maintenance lock,
 *  as every whole-stack operation does for its whole run. An `up` that died there is not starting. */
export function stackManagerStarting(root: string, space: string): boolean {
  try {
    const journal = readStackJournal(root)?.journal;
    if (journal?.space !== space || journal.operation.kind !== "up" || !stackOperationUnsettled(journal)) return false;
    return journal.members.some((row) => row.role === "manager" && row.state === "planned") && maintenanceLockHolder(root) === "alive";
  } catch { return false; }
}

/** Whether this root records a controller stack for `space` with no live manager instance. False
 *  when it records none, or an unreadable one, so a remote or legacy mesh keeps its own answer. */
export function stackManagerAbsent(root: string, space: string): boolean {
  try {
    if (readStackJournal(root)?.journal.space !== space) return false;
    return !serviceInstances(space, STACK_DEFINITION.manager).some((row) => observeServiceProcess(row.record.value) === "running");
  } catch { return false; }
}

/** The pid of this root's running stack manager for `space`, so a read it did not answer can name
 *  it. Undefined when the root records no stack for `space` or its records cannot be read. */
export function runningStackManagerPid(root: string, space: string): number | undefined {
  try {
    if (readStackJournal(root)?.journal.space !== space) return undefined;
    return serviceInstances(space, STACK_DEFINITION.manager).find((row) => observeServiceProcess(row.record.value) === "running")?.record.value.process?.pid;
  } catch { return undefined; }
}

/** The controller stack definition a legacy component name stands for in `space`, when that
 *  definition is saved there. A controller stack names its members stack-<role>. */
export function stackMemberFor(space: string, name: string): string | undefined {
  const role = ({ nats: "broker", broker: "broker", auth: "auth", delivery: "delivery", manager: "manager" } as Record<string, StackRole | undefined>)[name];
  if (!role) return undefined;
  try { return serviceDefinitionStore(space).read(STACK_DEFINITION[role]) ? STACK_DEFINITION[role] : undefined; } catch { return undefined; }
}

/** The controller stack definitions saved for `space` that start a stack at `root`. */
export function stackDefinitionsAt(space: string, root: string): ServiceDefinitionSnapshot[] {
  const store = serviceDefinitionStore(space);
  return STACK_ROLES.flatMap((role) => {
    const row = store.read(STACK_DEFINITION[role]), launch = row?.record.value.launch;
    return row && launch?.type === "adapter" && launch.adapter === STACK_ADAPTER[role] && launch.options.root === root ? [row] : [];
  });
}

/** Remove the controller stack definitions saved for `space` at `root`, with their stopped instance
 *  records, as `service remove` does, so that another folder can start a stack under the same name.
 *  A definition saved for another root is left alone. Nothing is removed while the root holds
 *  preserved state, which resumes from them, or while any of their instances is not removable;
 *  `kept` names them, why, and the route that removes them. */
export function releaseStackDefinitions(root: string, space: string): { released: string[]; kept?: { names: string[]; why: string } } {
  let owned: ServiceDefinitionSnapshot[];
  try { owned = stackDefinitionsAt(space, root); } catch (error) { return { released: [], kept: { names: [], why: `${(error as Error).message}; inspect them with cotal service --space ${space}` } }; }
  if (!owned.length) return { released: [] };
  const names = owned.map((row) => row.name);
  let preserved: boolean;
  try { preserved = existsSync(root) && readMaintenanceJournal(root) !== undefined; } catch { preserved = true; }
  if (preserved) return { released: [], kept: { names, why: `${root} holds preserved state that resumes from them` } };
  try {
    for (const row of owned) removableServiceInstances(space, row.name);
  } catch (error) {
    const route = existsSync(root) ? `stop the stack with cotal down --yes in ${root}, then run cotal space forget ${space} again`
      : isCommandFailure(error) && error.remedy || `inspect them with cotal service --space ${space}`;
    return { released: [], kept: { names, why: `${(error as Error).message}; ${route}` } };
  }
  const store = serviceDefinitionStore(space), released: string[] = [];
  try {
    for (const row of owned) { store.commit(row.name, row, undefined, () => removeStoppedInstanceRecords(space, row.name)); released.push(row.name); }
  } catch (error) {
    if (!released.length) throw error;
    throw new CommandFailure("partial", "OPERATION_PARTIAL", "some stack definitions were removed, but another changed before its removal", { target: { space, root }, changed: released.map((name) => ({ kind: "service-definition", name })), remedy: `inspect the rest with cotal service --space ${space}` });
  }
  return { released };
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
 *  found by listing what it names under `.cotal`. Nothing is read outside `<root>/.cotal`: a link on
 *  a record's path is listed at the link, unread. A live or unanswered pid, an unattributable,
 *  unreadable or oversized record, one that is not a regular file or changed while it was read, a
 *  record whose space segment decodes to no space and a directory that cannot be listed all count;
 *  only an empty or ESRCH-proven dead record of a known space does not. Each path is read once and
 *  each unread one listed once, where reading stopped, whichever descriptor reached it first. Read
 *  only: nothing is stopped, adopted or removed. */
export function recordedProcessesUnder(root: string, spaces: readonly string[]): RecordedProcess[] {
  const found: RecordedProcess[] = [], attempted = new Set<string>(), reported = new Set<string>();
  const unread = (name: string, at: string, why: string): void => {
    if (reported.has(at)) return;
    reported.add(at);
    found.push({ name, path: relative(root, at), note: why });
  };
  const read = (name: string, path: string, attributed: boolean): void => {
    if (attempted.has(path)) return;
    attempted.add(path);
    const record = readContainedRecord(root, path);
    if (record.state === "absent") return;
    if (record.state === "unread") return unread(name, record.at, record.why);
    const { raw } = record, at = { name, path: relative(root, path) };
    const pid = raw ? parsePid(raw) : undefined;
    if (!attributed) found.push({ ...at, ...(pid === undefined ? {} : { pid }), note: pid === undefined ? "unattributable record name" : `unattributable record name, pid ${pid}` });
    else if (raw && pid === undefined) found.push({ ...at, note: "unattributable record" });
    else if (pid !== undefined && probeLiveness(pid) !== "dead") found.push({ ...at, pid, note: `pid ${pid}` });
  };
  for (const component of localProcessSurface()) {
    for (const space of spaces) for (const path of localProcessPathCandidates(component.pidFile, { root, space })) read(component.name, path, true);
    for (const match of recordedLocalProcessPaths(component.pidFile, root))
      if (match.unread === undefined) read(component.name, match.path, match.space !== undefined);
      else unread(component.name, match.path, match.unread);
  }
  return found;
}

/** No member of this stack ever launched: no member row names an instance or a replacement, and every
 *  instance record of a stack definition in its space failed before its child was spawned, as a
 *  broker start refused at an address another program holds does. No process of it runs and no
 *  broker of it wrote a store, so its journal pins nothing for the next up and a down has nothing to stop. */
export function stackNeverStarted(journal: StackJournal): boolean {
  return journal.members.every((row) => row.instanceId === null && row.replacement === undefined)
    && STACK_ROLES.every((role) => serviceInstances(journal.space, STACK_DEFINITION[role]).every((row) => row.record.value.state === "failed" && row.record.value.process === undefined));
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
  if (others.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "other service instances in this space are live or unresolved and depend on its broker; the broker was not stopped under them", { target: { space: journal.space, dependants: others.map((row) => ({ definition: row.record.value.definition, instanceId: row.name })) }, remedy: `stop each with ${others.map((row) => `cotal svc stop ${row.record.value.definition} --instance ${row.name} --space ${journal.space} --yes`).join("; ")}, then run ${next}` });
  const legacy = foreignLocalProcesses(journal.root, journal.space);
  if (legacy.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "legacy pidfile-owned processes under this root may depend on the broker; they were neither adopted nor stopped", { target: { root: journal.root, processes: legacy } });
  const sharing = loadMeshes().filter((mesh) => mesh.space !== journal.space && mesh.server === journal.server);
  if (sharing.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another registration names this stack's exact broker address; a shared broker is not stopped in this cut", { target: { server: journal.server, spaces: sharing.map((mesh) => mesh.space) } });
}
