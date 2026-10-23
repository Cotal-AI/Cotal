/** The root-local whole-stack journal: which controller definitions and full instances one local
 *  stack owns, and the last whole-stack operation's per-member outcome. One owner-private file at
 *  `<root>/.cotal/stack-controller.json`. It is not a service record, unit receipt or team ledger,
 *  and it grants no stop authority by itself: every effect still rechecks the instance records. */
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { acquireLock, writeSecretFileAtomic } from "@cotal-ai/core";
import { CommandFailure, acquireMaintenanceLock, admittedControllerRestore, canonicalRoot, decodeLocalJson, isMaintenanceError, loadMeshes, localProcessPath, localProcessPathCandidates, localRecordObject, maintenancePaths, parsePid, probeLiveness, readContainedRecord, readLocalRecordSource, readMaintenanceJournal, readPidfile, recordedLocalProcessPaths, serviceOperationId, type ControllerStackView, type MaintenanceLock, type ServiceAdapterStopAbandonment, stackJournalPath } from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { serviceDefinitionStore } from "./service-definitions.js";
import { observeServiceProcess, serviceInstances, type ServiceInstance, type ServiceInstanceSnapshot } from "./service-instances.js";
import { abandonableSignalStop, abandonRetainedNativeStop, abandonRetainedSignalStop, retainedStopRequest, settleExitedInstance, settleRetainedNativeStop } from "./service-process.js";

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
    const member = localRecordObject(row, ["role", "definition", "instanceId", "state", "code", "replacement"]);
    const role = STACK_ROLES[index]!;
    if (member.role !== role || member.definition !== STACK_DEFINITION[role] || !STATES.includes(String(member.state)) || member.code !== undefined && (typeof member.code !== "string" || !/^[A-Z_]{1,64}$/.test(member.code))) invalid();
    if (member.instanceId !== null) { try { serviceOperationId(member.instanceId); } catch { invalid(); } }
    if (member.replacement !== undefined) replacementOf(member.replacement);
    if (!stackRoleApplies(value.mode as StackMode, role) && (member.instanceId !== null || member.state !== "not-attempted" || member.replacement !== undefined)) invalid();
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

function replacementOf(input: unknown): StackReplacement {
  const value = localRecordObject(input, ["operation", "instanceId", "launchRequestId", "definitionRevision"]);
  try { for (const id of [value.operation, value.instanceId, value.launchRequestId, ...(value.definitionRevision === undefined ? [] : [value.definitionRevision])]) serviceOperationId(id); } catch { invalid(); }
  return value as unknown as StackReplacement;
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

/** Take the root's maintenance lock for one whole-stack operation. Every whole-stack operation
 *  holds it for its whole run, and a dead holder is reclaimed only when its PID is proven dead. A
 *  live holder is a known refusal that names its PID; nothing was read or changed. */
export function acquireStackOperationLock(root: string): MaintenanceLock {
  try { return acquireMaintenanceLock(root); }
  catch (error) {
    if (!isMaintenanceError(error) || error.code !== "lock-held") throw error;
    let holder: number | undefined;
    try { holder = (decodeLocalJson(readLocalRecordSource(maintenancePaths(root).lock, 64 * 1024) ?? Buffer.from("null")) as { owner?: { pid?: unknown } } | null)?.owner?.pid as number | undefined; } catch { holder = undefined; }
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `another whole-stack or maintenance operation holds this root${Number.isSafeInteger(holder) ? ` (pid ${holder})` : ""}; nothing was changed`, { target: { root, ...(Number.isSafeInteger(holder) ? { holderPid: holder } : {}) }, remedy: "run the command again after that operation exits; a foreground cotal up holds the root only while it starts" });
  }
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
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", !stopRetained
      ? "a stack member's process is neither live nor proven gone, so the earlier whole-stack operation cannot be settled from evidence; nothing was retried"
      : retained?.publication === "unknown"
        ? "a stack member's stop request file does not read as its own, so whether a stop was published is unknown and the earlier whole-stack operation cannot be settled from evidence; nothing was retried"
        : "a stack member retains an unconfirmed stop request, so the earlier whole-stack operation cannot be settled from evidence; nothing was retried", { target: { ...target, instanceId: row.name, recordedState: value.state, process: observed, ...(stopRetained ? { requestId: retained?.requestId ?? value.requestId, ...(retained ? { stopPublication: retained.publication } : {}) } : {}) }, remedy: retained?.publication === "published" ? `${inspect(row.name)}; ${abandonRemedy(retained.requestId)}` : abandonableSignalStop(value) ? `${inspect(row.name)}; ${abandonRemedy(value.requestId)}` : inspect(row.name) });
  } finally { hold?.release(); }
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

/** Whether this root records a controller stack for `space` with no live manager instance. False
 *  when it records none, or an unreadable one, so a remote or legacy mesh keeps its own answer. */
export function stackManagerAbsent(root: string, space: string): boolean {
  try {
    if (readStackJournal(root)?.journal.space !== space) return false;
    return !serviceInstances(space, STACK_DEFINITION.manager).some((row) => observeServiceProcess(row.record.value) === "running");
  } catch { return false; }
}

/** The controller stack definition a legacy component name stands for in `space`, when that
 *  definition is saved there. A controller stack names its members stack-<role>. */
export function stackMemberFor(space: string, name: string): string | undefined {
  const role = ({ nats: "broker", broker: "broker", auth: "auth", delivery: "delivery", manager: "manager" } as Record<string, StackRole | undefined>)[name];
  if (!role) return undefined;
  try { return serviceDefinitionStore(space).read(STACK_DEFINITION[role]) ? STACK_DEFINITION[role] : undefined; } catch { return undefined; }
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

/** No member of this stack ever launched: no member row names an instance or a replacement, and no
 *  stack definition in its space has an instance record. No process of it runs and no broker of it
 *  wrote a store, so its journal pins nothing for the next up and a down has nothing to stop. */
export function stackNeverStarted(journal: StackJournal): boolean {
  return journal.members.every((row) => row.instanceId === null && row.replacement === undefined)
    && STACK_ROLES.every((role) => serviceInstances(journal.space, STACK_DEFINITION[role]).length === 0);
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
